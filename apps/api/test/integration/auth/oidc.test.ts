import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as oidcDiagnostics from "../../../src/auth/oidc-diagnostics";
import { uniqueId } from "../../helpers/api";
import { createFakeIdp, type FakeIdp } from "../../helpers/fake-idp";
import { installFakeIdpFetch } from "./fake-idp-fetch";
import { requestWithEnv, type RuntimeTestEnv } from "./helpers";

const FAKE_IDP_ISSUER = "https://fake-idp.test";
const OIDC_CLIENT_SECRET = "test-oidc-client-secret";

type AuthorizeResult = {
	response: Response;
	url: URL;
	cookie: string;
};

describe("auth OIDC integration", () => {
	let recordSpy: ReturnType<typeof vi.spyOn> | undefined;

	beforeEach(() => {
		oidcDiagnostics.resetOidcDiagnosticsStateForTests();
		recordSpy = vi.spyOn(oidcDiagnostics, "recordOidcDiagnostic");
	});

	afterEach(() => {
		recordSpy?.mockRestore();
	});

	it("returns a spec-correct authorization URL for POST /api/auth/sign-in/social", async () => {
		const idp = await setUpFakeIdp();
		const testEnv = oidcTestEnv(idp);

		const authorize = await startOidcSignIn(testEnv);

		// A regression to /oauth2/callback/oidc silently breaks every deployed
		// operator IdP registration: genericOAuth does not register its own
		// endpoints, it injects providers into ctx.socialProviders, so the flow
		// runs through the standard social sign-in/callback routes.
		expect(authorize.url.searchParams.get("response_type")).toBe("code");
		expect(authorize.url.searchParams.get("scope")?.split(" ")).toContain("openid");
		expect(authorize.url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(authorize.url.searchParams.get("redirect_uri")).toBe(
			`${apiOrigin()}/api/auth/callback/oidc`,
		);
		expect(authorize.url.searchParams.get("nonce")).toBeTruthy();
	});

	it("creates a session carrying the IdP-asserted email after a valid callback", async () => {
		const idp = await setUpFakeIdp();
		const testEnv = oidcTestEnv(idp);
		const assertedEmail = `${uniqueId("oidc-sign-up")}@idp.example`;

		const authorize = await startOidcSignIn(testEnv);
		signIdTokenForCallback(idp, authorize, { sub: uniqueId("oidc-sub"), email: assertedEmail });

		const callback = await completeOidcCallback(testEnv, authorize);

		// The callback is a redirect handed to the browser, never a JSON API
		// response - the whole point of the authorization-code flow.
		expect(callback.status).toBe(302);

		const session = await requestWithEnv("/api/auth/get-session", testEnv, {
			headers: { cookie: setCookieHeader(callback) },
		});
		expect(session.status).toBe(200);
		const sessionJson = (await session.json()) as { user?: { email?: string } } | null;
		// The email IS the identity contract here, so this pins the exact value.
		expect(sessionJson?.user?.email).toBe(assertedEmail);
	});

	it("sends the PKCE code_verifier and authorization_code grant type to the token endpoint", async () => {
		const idp = await setUpFakeIdp();
		const testEnv = oidcTestEnv(idp);

		const authorize = await startOidcSignIn(testEnv);
		signIdTokenForCallback(idp, authorize, { sub: uniqueId("oidc-sub") });
		await completeOidcCallback(testEnv, authorize);

		const tokenRequest = idp.lastTokenRequest();
		expect(tokenRequest?.params.get("grant_type")).toBe("authorization_code");
		expect(tokenRequest?.params.get("code_verifier")).toBeTruthy();
	});

	it("rejects an id_token signed by a key absent from the published JWKS", async () => {
		const idp = await setUpFakeIdp();
		const testEnv = oidcTestEnv(idp);

		const authorize = await startOidcSignIn(testEnv);
		const nonce = authorize.url.searchParams.get("nonce") ?? "";
		idp.tokenHandler = async () => ({
			status: 200,
			body: idp.tokenResponse(
				await idp.signWithUnpublishedKey({ nonce, sub: uniqueId("oidc-sub") }),
			),
		});

		const callback = await completeOidcCallback(testEnv, authorize);

		expect(setCookieHeader(callback)).not.toContain("better-auth.session_token=");
		const session = await requestWithEnv("/api/auth/get-session", testEnv, {
			headers: { cookie: authorize.cookie },
		});
		expect(session.status).toBe(200);
		expect(await session.json()).toBeNull();
	});

	it("rejects an id_token with a mismatched nonce", async () => {
		const idp = await setUpFakeIdp();
		const testEnv = oidcTestEnv(idp);

		const authorize = await startOidcSignIn(testEnv);
		idp.tokenHandler = async () => ({
			status: 200,
			// Nonce binding is on by default whenever discovery yields a JWKS
			// (requiresIdTokenNonce) and is verified as an exact match, so a
			// value that does not echo the authorize request's nonce must fail.
			body: idp.tokenResponse(
				await idp.signIdToken({ nonce: "not-the-authorize-nonce", sub: uniqueId("oidc-sub") }),
			),
		});

		const callback = await completeOidcCallback(testEnv, authorize);

		expect(setCookieHeader(callback)).not.toContain("better-auth.session_token=");
		const session = await requestWithEnv("/api/auth/get-session", testEnv, {
			headers: { cookie: authorize.cookie },
		});
		expect(session.status).toBe(200);
		expect(await session.json()).toBeNull();
	});

	it("permits an OIDC sign-up for a non-allowlisted email while still rejecting the same email over password sign-up", async () => {
		const idp = await setUpFakeIdp();
		const oidcEmail = `${uniqueId("oidc-allowlist-bypass")}@idp.example`;
		// Same self-hosted deployment, same AUTH_ALLOWED_EMAILS value, for both
		// halves of this test: proving the asymmetry (IdP gates its own
		// identities; the allowlist still gates passwords) requires exercising
		// both paths against one configuration, not two separately-asserted files.
		const testEnv = oidcTestEnv(idp, {
			SELF_HOSTED: true,
			EMAIL: undefined,
			AUTH_ALLOWED_EMAILS: "unrelated-allowlisted-user@example.com",
		});

		const authorize = await startOidcSignIn(testEnv);
		signIdTokenForCallback(idp, authorize, { sub: uniqueId("oidc-sub"), email: oidcEmail });
		const callback = await completeOidcCallback(testEnv, authorize);
		expect(callback.status).toBe(302);

		const session = await requestWithEnv("/api/auth/get-session", testEnv, {
			headers: { cookie: setCookieHeader(callback) },
		});
		expect(session.status).toBe(200);
		const sessionJson = (await session.json()) as { user?: { email?: string } } | null;
		expect(sessionJson?.user?.email).toBe(oidcEmail);

		const passwordEmail = `${uniqueId("still-gated-password")}@example.com`;
		const passwordSignUp = await requestWithEnv("/api/auth/sign-up/email", testEnv, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: "Still Gated",
				email: passwordEmail,
				password: "supersecret123",
			}),
		});
		expect(passwordSignUp.status).toBe(403);
		expect(await passwordSignUp.json()).toMatchObject({ code: "SIGN_UP_EMAIL_NOT_ALLOWED" });
	});

	it("leaves OIDC unreachable and genericOAuth unregistered when OIDC env is unset", async () => {
		const testEnv: RuntimeTestEnv = {
			...env,
			SELF_HOSTED: false,
			DEV_MODE: true,
			OIDC_DISCOVERY_URL: undefined,
			OIDC_CLIENT_ID: undefined,
			OIDC_CLIENT_SECRET: undefined,
		};

		const response = await requestWithEnv("/api/auth/sign-in/social", testEnv, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				provider: "oidc",
				callbackURL: `${apiOrigin()}/dashboard`,
			}),
		});

		expect(response.status).toBeGreaterThanOrEqual(400);
		const body = (await response.json().catch(() => null)) as { url?: string } | null;
		expect(body?.url).toBeFalsy();
	});

	it("rejects a non-allowlisted email-password sign-up submitted as a browser form post, matching the JSON-fetch rejection", async () => {
		// DECISION (recorded per the bead notes): the plan asked for an OIDC
		// callback rejected by validateUserInfo through a browser (non-JSON)
		// path. In this deployment isAllowlistExemptSource() is true for every
		// OIDC-sourced create-user, so the allowlist can never reject an OIDC
		// callback - there is no such path to exercise without giving the fake
		// IdP a business rule the app does not itself implement. Retargeted at
		// the analogous non-JSON entrypoint that does still gate on the
		// allowlist: a browser <form> POST to sign-up/email, which better-auth
		// accepts as application/x-www-form-urlencoded.
		const allowedEmail = `${uniqueId("form-post-allowed")}@example.com`;
		const deniedEmail = `${uniqueId("form-post-denied")}@example.com`;
		const testEnv: RuntimeTestEnv = {
			...env,
			SELF_HOSTED: true,
			EMAIL: undefined,
			AUTH_ALLOWED_EMAILS: allowedEmail,
		};

		const formBody = new URLSearchParams({
			name: "Form Post User",
			email: deniedEmail,
			password: "supersecret123",
		});

		const response = await requestWithEnv("/api/auth/sign-up/email", testEnv, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: formBody.toString(),
		});

		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ code: "SIGN_UP_EMAIL_NOT_ALLOWED" });
	});

	it("logs an allowlist rejection by code and method only, never the rejected email", async () => {
		const deniedEmail = `${uniqueId("diagnostic-denied")}@example.com`;
		const testEnv: RuntimeTestEnv = {
			...env,
			SELF_HOSTED: true,
			EMAIL: undefined,
			AUTH_ALLOWED_EMAILS: "unrelated-allowlisted-user@example.com",
		};

		const response = await requestWithEnv("/api/auth/sign-up/email", testEnv, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: "Diagnostic Denied",
				email: deniedEmail,
				password: "supersecret123",
			}),
		});
		expect(response.status).toBe(403);

		expect(recordSpy).toHaveBeenCalledTimes(1);
		const [, detail] = recordSpy?.mock.calls[0] ?? [];
		expect(detail).toMatchObject({
			code: "SIGN_UP_EMAIL_NOT_ALLOWED",
			method: "email-password",
		});
		// The rejected email is attacker-supplied input to an unauthenticated
		// endpoint; it must never reach the log even though it was available in
		// scope when the diagnostic was recorded.
		expect(JSON.stringify(detail)).not.toContain(deniedEmail);
	});
});

async function setUpFakeIdp(): Promise<FakeIdp> {
	const idp = await createFakeIdp(FAKE_IDP_ISSUER);
	installFakeIdpFetch(idp, {
		discoveryUrl: idp.discoveryUrl,
		jwksUrl: idp.jwksUrl,
		tokenUrl: idp.tokenUrl,
	});
	return idp;
}

function apiOrigin(): string {
	return new URL(process.env.BETTER_AUTH_URL ?? "").origin;
}

function oidcTestEnv(idp: FakeIdp, overrides: Partial<RuntimeTestEnv> = {}): RuntimeTestEnv {
	return {
		...env,
		SELF_HOSTED: false,
		// Bypasses the managed-edition email-verification requirement so these
		// tests do not also need an EMAIL binding to construct Better Auth.
		DEV_MODE: true,
		OIDC_DISCOVERY_URL: idp.discoveryUrl,
		OIDC_CLIENT_ID: idp.clientId,
		OIDC_CLIENT_SECRET,
		...overrides,
	};
}

function setCookieHeader(response: Response): string {
	return response.headers
		.getSetCookie()
		.map((pair) => pair.split(";")[0] ?? "")
		.filter(Boolean)
		.join("; ");
}

async function startOidcSignIn(testEnv: RuntimeTestEnv): Promise<AuthorizeResult> {
	const response = await requestWithEnv("/api/auth/sign-in/social", testEnv, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			provider: "oidc",
			callbackURL: `${apiOrigin()}/dashboard`,
			errorCallbackURL: `${apiOrigin()}/sign-in-error`,
		}),
	});
	const body = (await response.json()) as { url?: string };
	if (!body.url) {
		throw new Error(
			`sign-in/social did not return an authorization url (status ${response.status})`,
		);
	}

	return { response, url: new URL(body.url), cookie: setCookieHeader(response) };
}

async function completeOidcCallback(
	testEnv: RuntimeTestEnv,
	authorize: AuthorizeResult,
): Promise<Response> {
	const state = authorize.url.searchParams.get("state") ?? "";
	return await requestWithEnv(
		`/api/auth/callback/oidc?code=fake-authorization-code&state=${encodeURIComponent(state)}`,
		testEnv,
		{
			redirect: "manual",
			headers: { cookie: authorize.cookie },
		},
	);
}

/** Signs an id_token that echoes the authorize request's nonce, so verification succeeds. */
function signIdTokenForCallback(
	idp: FakeIdp,
	authorize: AuthorizeResult,
	overrides: { email?: string; sub?: string } = {},
): void {
	const nonce = authorize.url.searchParams.get("nonce") ?? "";
	idp.tokenHandler = async () => ({
		status: 200,
		body: idp.tokenResponse(
			await idp.signIdToken({ nonce, email: overrides.email, sub: overrides.sub }),
		),
	});
}
