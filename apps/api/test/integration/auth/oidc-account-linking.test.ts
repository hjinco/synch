import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createDb } from "../../../src/db/client";
import * as schema from "../../../src/db/d1";
import { uniqueId } from "../../helpers/api";
import { createFakeIdp, type FakeIdp } from "../../helpers/fake-idp";
import { installFakeIdpFetch } from "./fake-idp-fetch";
import { requestWithEnv, type RuntimeTestEnv } from "./helpers";

const FAKE_IDP_ISSUER = "https://fake-idp.test";
const OIDC_CLIENT_SECRET = "test-oidc-client-secret";
const PASSWORD = "supersecret123";

type AuthorizeResult = {
	response: Response;
	url: URL;
	cookie: string;
};

// Linking follows the same policy as the built-in social providers: an IdP
// sign-in links into the local row owning the asserted email only when the
// IdP asserts email_verified, and an unverified assertion is rejected outright.
// Community deployments never verify email locally, so a pre-registered
// password row is linked without local verification there.
//
// Assertions query `schema.user`/`schema.account` directly: a session alone
// cannot distinguish "linked into the pre-existing user" from "created a
// second user with the same email" - only row identity can.
describe("OIDC account linking", () => {
	it("links a verified OIDC sign-in into a pre-registered, unverified password account with the same email", async () => {
		const idp = await setUpFakeIdp();
		const email = `${uniqueId("victim")}@example.com`;
		const testEnv = oidcTestEnv(idp, email);

		const signUp = await signUpPassword(testEnv, email);
		expect(signUp.status).toBe(200);

		const [preRegisteredUser] = await findUserRowsByEmail(email);
		if (!preRegisteredUser) {
			throw new Error("pre-registered user row was not created");
		}

		const authorize = await startOidcSignIn(testEnv);
		signIdTokenForCallback(idp, authorize, {
			sub: uniqueId("oidc-sub"),
			email,
			emailVerified: true,
		});
		const callback = await completeOidcCallback(testEnv, authorize);
		expect(callback.status).toBe(302);

		const linkedAccounts = await findOidcAccountRows(idp.issuer);
		expect(linkedAccounts).toHaveLength(1);
		expect(linkedAccounts[0]?.userId).toBe(preRegisteredUser.id);

		const session = await requestWithEnv("/api/auth/get-session", testEnv, {
			headers: { cookie: setCookieHeader(callback) },
		});
		expect(session.status).toBe(200);
		const sessionJson = (await session.json()) as { user?: { id?: string } } | null;
		expect(sessionJson?.user?.id).toBe(preRegisteredUser.id);
	});

	it("promotes the local row to emailVerified: true after the first successful link", async () => {
		const idp = await setUpFakeIdp();
		const email = `${uniqueId("promote")}@example.com`;
		const testEnv = oidcTestEnv(idp, email);

		const signUp = await signUpPassword(testEnv, email);
		expect(signUp.status).toBe(200);

		const [beforeLink] = await findUserRowsByEmail(email);
		if (!beforeLink) {
			throw new Error("pre-registered user row was not created");
		}
		expect(beforeLink.emailVerified).toBe(false);

		const authorize = await startOidcSignIn(testEnv);
		signIdTokenForCallback(idp, authorize, {
			sub: uniqueId("oidc-sub"),
			email,
			emailVerified: true,
		});
		const callback = await completeOidcCallback(testEnv, authorize);
		expect(callback.status).toBe(302);

		const [afterLink] = await findUserRowsByEmail(email);
		expect(afterLink?.id).toBe(beforeLink.id);
		expect(afterLink?.emailVerified).toBe(true);
	});

	it("creates a fresh user for an OIDC identity with no matching local row", async () => {
		const idp = await setUpFakeIdp();
		const testEnv = oidcTestEnv(idp);
		const freshEmail = `${uniqueId("fresh-oidc")}@idp.example`;
		const sub = uniqueId("oidc-sub");

		const authorize = await startOidcSignIn(testEnv);
		signIdTokenForCallback(idp, authorize, { sub, email: freshEmail, emailVerified: true });
		const callback = await completeOidcCallback(testEnv, authorize);
		expect(callback.status).toBe(302);

		const matchingUsers = await findUserRowsByEmail(freshEmail);
		expect(matchingUsers).toHaveLength(1);
		const [createdUser] = matchingUsers;
		if (!createdUser) {
			throw new Error("expected a freshly created user row");
		}

		const linkedAccount = await findOidcAccountRowsBySubject(idp.issuer, sub);
		expect(linkedAccount).toHaveLength(1);
		expect(linkedAccount[0]?.providerId).toBe("oidc");
		expect(linkedAccount[0]?.userId).toBe(createdUser.id);
	});

	it("rejects an OIDC sign-in into an existing account when the IdP asserts email_verified: false", async () => {
		const idp = await setUpFakeIdp();
		const email = `${uniqueId("unverified-claim")}@example.com`;
		const testEnv = oidcTestEnv(idp, email);
		const sub = uniqueId("oidc-sub");

		const signUp = await signUpPassword(testEnv, email);
		expect(signUp.status).toBe(200);

		const authorize = await startOidcSignIn(testEnv);
		signIdTokenForCallback(idp, authorize, { sub, email, emailVerified: false });
		const callback = await completeOidcCallback(testEnv, authorize);

		expect(callbackErrorCode(callback)).not.toBeNull();
		expect(setCookieHeader(callback)).not.toContain("session_token");
		expect(await findOidcAccountRowsBySubject(idp.issuer, sub)).toHaveLength(0);
	});

	it("rejects an OIDC sign-up when the IdP asserts email_verified: false", async () => {
		const idp = await setUpFakeIdp();
		const testEnv = oidcTestEnv(idp);
		const email = `${uniqueId("unverified-signup")}@idp.example`;
		const sub = uniqueId("oidc-sub");

		const authorize = await startOidcSignIn(testEnv);
		signIdTokenForCallback(idp, authorize, { sub, email, emailVerified: false });
		const callback = await completeOidcCallback(testEnv, authorize);

		expect(callbackErrorCode(callback)).toBe("email_not_verified");
		expect(await findUserRowsByEmail(email)).toHaveLength(0);
		expect(await findOidcAccountRowsBySubject(idp.issuer, sub)).toHaveLength(0);
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

function oidcTestEnv(idp: FakeIdp, allowedEmail = "owner@example.com"): RuntimeTestEnv {
	return {
		...env,
		SELF_HOSTED: true,
		AUTH_ALLOWED_EMAILS: allowedEmail,
		OIDC_DISCOVERY_URL: idp.discoveryUrl,
		OIDC_CLIENT_ID: idp.clientId,
		OIDC_CLIENT_SECRET,
	};
}

function callbackErrorCode(response: Response): string | null {
	const location = response.headers.get("location");
	return location ? new URL(location, apiOrigin()).searchParams.get("error") : null;
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
	overrides: { email?: string; sub?: string; emailVerified?: boolean } = {},
): void {
	const nonce = authorize.url.searchParams.get("nonce") ?? "";
	idp.tokenHandler = async () => ({
		status: 200,
		body: idp.tokenResponse(
			await idp.signIdToken({
				nonce,
				email: overrides.email,
				sub: overrides.sub,
				email_verified: overrides.emailVerified,
			}),
		),
	});
}

async function signUpPassword(testEnv: RuntimeTestEnv, email: string): Promise<Response> {
	return await requestWithEnv("/api/auth/sign-up/email", testEnv, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: "Pre-registered account", email, password: PASSWORD }),
	});
}

async function findUserRowsByEmail(
	email: string,
): Promise<(typeof schema.user.$inferSelect)[]> {
	const db = createDb(env.DB);
	return await db.select().from(schema.user).where(eq(schema.user.email, email));
}

async function findOidcAccountRows(
	issuer: string,
): Promise<(typeof schema.account.$inferSelect)[]> {
	const db = createDb(env.DB);
	return await db
		.select()
		.from(schema.account)
		.where(and(eq(schema.account.issuer, issuer), eq(schema.account.providerId, "oidc")));
}

async function findOidcAccountRowsBySubject(
	issuer: string,
	sub: string,
): Promise<(typeof schema.account.$inferSelect)[]> {
	const db = createDb(env.DB);
	return await db
		.select()
		.from(schema.account)
		.where(and(eq(schema.account.issuer, issuer), eq(schema.account.accountId, sub)));
}
