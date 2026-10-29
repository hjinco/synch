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

// This suite is the regression pin for account-linking behaviour and pins two
// separate concerns at once: the accepted (deliberate) risk that any local
// row already owning an asserted email absorbs an IdP sign-in regardless of
// how that row was created, and better-auth's `requireLocalEmailVerified`
// option, which upstream (1.7.1, src/oauth2/link-account.ts:160-166) marks
// `@deprecated` with a `FIXME(next-minor)` to make the local-row gate
// unconditional. There is no newer better-auth release to test against, so
// this file exists to make a future version bump fail loudly here rather
// than silently changing who gets linked into whom.
//
// Every assertion below queries `schema.user`/`schema.account` directly via
// `createDb(env.DB)` rather than trusting an HTTP 200 or a session cookie:
// a session alone cannot distinguish "linked into the pre-existing user" from
// "silently created a second user with the same email" - only row identity
// can. The two tables adjudicate collisions differently and neither is what
// decides linking: `account` uniquely constrains on (issuer, account_id) so
// the same IdP subject can never produce two account rows, and `user`
// uniquely constrains on `email` so two local rows can never share an
// address; the actual linking decision (reuse this user row vs. create a new
// one) is made by looking up an existing `user` row by the IdP-asserted
// email, then consulting the `accountLinking` guard this file pins.
describe("OIDC account linking", () => {
	it("auto-links an OIDC sign-in into a pre-registered, unverified password account asserting the same email", async () => {
		const idp = await setUpFakeIdp();
		const testEnv = oidcTestEnv(idp);
		// No interaction from the eventual OIDC user: the row could have been
		// created by anyone who merely guessed or knew an allowlisted address.
		const victimEmail = `${uniqueId("victim")}@example.com`;

		const signUp = await signUpPassword(testEnv, victimEmail);
		expect(signUp.status).toBe(200);

		const [preRegisteredUser] = await findUserRowsByEmail(victimEmail);
		if (!preRegisteredUser) {
			throw new Error("pre-registered user row was not created");
		}

		const authorize = await startOidcSignIn(testEnv);
		signIdTokenForCallback(idp, authorize, {
			sub: uniqueId("oidc-sub"),
			email: victimEmail,
			emailVerified: true,
		});
		const callback = await completeOidcCallback(testEnv, authorize);
		expect(callback.status).toBe(302);

		// Pins the deliberate auto-link/hijack-acceptance shape: an IdP sign-in
		// always resolves into whatever local row already owns the email, even
		// if that row predates any legitimate owner interaction. A failure here
		// is a regression to investigate, not a test to update: re-read this
		// project's account-linking risk analysis and the upstream deprecation
		// this file is pinned against before touching this assertion - a change
		// here is either an upstream regression or a deliberate mitigation of
		// that risk, never a routine test fix.
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
		const testEnv = oidcTestEnv(idp);
		const email = `${uniqueId("promote")}@example.com`;

		const signUp = await signUpPassword(testEnv, email);
		expect(signUp.status).toBe(200);

		const [beforeLink] = await findUserRowsByEmail(email);
		if (!beforeLink) {
			throw new Error("pre-registered user row was not created");
		}
		// Asserting the pre-condition first: a self-hosted password sign-up never
		// verifies email locally, so asserting only the post-link state would
		// risk a false pass if this row somehow started out already verified.
		expect(beforeLink.emailVerified).toBe(false);

		const authorize = await startOidcSignIn(testEnv);
		signIdTokenForCallback(idp, authorize, {
			sub: uniqueId("oidc-sub"),
			email,
			emailVerified: true,
		});
		const callback = await completeOidcCallback(testEnv, authorize);
		expect(callback.status).toBe(302);

		// This is the self-healing behaviour at upstream link-account.ts:237-246:
		// linking a verified IdP identity into a locally-unverified row promotes
		// that row's emailVerified flag rather than leaving it permanently stale.
		// A failure here is a regression to investigate, not a test to update -
		// the behaviour is deliberate and accepted.
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

		// Distinguishing "created fresh" from "linked" is the whole point of this
		// case: a failure here (an extra row, or a reused id) is a regression to
		// investigate, not a test to update.
		const matchingUsers = await findUserRowsByEmail(freshEmail);
		expect(matchingUsers).toHaveLength(1);
		const [createdUser] = matchingUsers;
		if (!createdUser) {
			throw new Error("expected a freshly created user row");
		}

		const db = createDb(env.DB);
		const linkedAccount = await db
			.select()
			.from(schema.account)
			.where(and(eq(schema.account.issuer, idp.issuer), eq(schema.account.accountId, sub)));
		expect(linkedAccount).toHaveLength(1);
		expect(linkedAccount[0]?.providerId).toBe("oidc");
		expect(linkedAccount[0]?.userId).toBe(createdUser.id);
	});

	it("links the same way when the IdP asserts email_verified: false", async () => {
		const idp = await setUpFakeIdp();
		const testEnv = oidcTestEnv(idp);
		const email = `${uniqueId("unverified-claim")}@example.com`;
		const sub = uniqueId("oidc-sub");

		const signUp = await signUpPassword(testEnv, email);
		expect(signUp.status).toBe(200);

		const [preRegisteredUser] = await findUserRowsByEmail(email);
		if (!preRegisteredUser) {
			throw new Error("pre-registered user row was not created");
		}
		expect(preRegisteredUser.emailVerified).toBe(false);

		const authorize = await startOidcSignIn(testEnv);
		signIdTokenForCallback(idp, authorize, { sub, email, emailVerified: false });
		const callback = await completeOidcCallback(testEnv, authorize);
		expect(callback.status).toBe(302);

		// trustedProviders clears the linking guard's provider-side clause
		// regardless of what the IdP claims about email verification, so the
		// link must still occur here - this covers the full accepted-risk
		// surface rather than only the email_verified: true path. A failure here
		// is a regression to investigate, not a test to update; the behaviour is
		// deliberate and accepted.
		const db = createDb(env.DB);
		const linkedAccount = await db
			.select()
			.from(schema.account)
			.where(and(eq(schema.account.issuer, idp.issuer), eq(schema.account.accountId, sub)));
		expect(linkedAccount).toHaveLength(1);
		expect(linkedAccount[0]?.userId).toBe(preRegisteredUser.id);

		// Promotion (upstream link-account.ts:237-246) requires the provider's
		// own verified claim, so this variant's local row stays unverified -
		// this is the one case that still depends on the deprecated
		// requireLocalEmailVerified flag: an unverified claim linking into a
		// pre-existing unverified row. Should upstream ever make the local-row
		// gate unconditional per its own FIXME, this exact combination is where
		// linking would first start failing.
		const [afterLink] = await findUserRowsByEmail(email);
		expect(afterLink?.emailVerified).toBe(false);
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
