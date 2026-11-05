import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAuthFeature } from "../composition/features/create-auth-feature";
import { createLibsqlDb } from "../db/client";
import { createFakeIdp } from "../../test/helpers/fake-idp";
import { OIDC_RETRY_COOLDOWN_MS } from "./oidc-auth";
import { parseOidcProviderConfig } from "./policies/oidc";

const baseURL = "http://localhost:8787";
let client: Client;
beforeEach(async () => {
	client = createClient({ url: ":memory:" });
	await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
});
afterEach(() => { client.close(); vi.unstubAllGlobals(); });

async function fixture() {
	const idp = await createFakeIdp("https://idp.example/tenant");
	const auth = createAuthFeature(createLibsqlDb(client), {
		baseURL, trustedOrigins: [baseURL], emailVerification: "disabled", devMode: false,
		secret: "a-long-test-secret-with-at-least-32-characters",
		allowedEmails: "owner@example.com", googleClientId: "google", googleClientSecret: "secret",
		oidc: parseOidcProviderConfig({ discoveryUrl: idp.discoveryUrl, clientId: idp.clientId, clientSecret: "secret" }),
	});
	const request = (path: string, body?: unknown, cookie = "") => auth.authHttpHandler(new Request(`${baseURL}/api/auth/${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: { "content-type": "application/json", origin: baseURL, cookie },
		body: body === undefined ? undefined : JSON.stringify(body),
	}));
	return { idp, auth, request };
}

it("keeps local authentication independent of stalled discovery and accepts a late recovery without duplicate fetches", async () => {
	let finish!: (response: Response) => void;
	const pending = new Promise<Response>((resolve) => { finish = resolve; });
	const fetchMock = vi.fn(() => pending);
	vi.stubGlobal("fetch", fetchMock);
	const { idp, auth, request } = await fixture();
	const providers = await request("providers");
	expect(await providers.json()).toMatchObject({ oidc: { providerId: "oidc" } });
	expect(fetchMock).not.toHaveBeenCalled();

	let oidcFinished = false;
	const oidc = request("sign-in/social", { provider: "oidc" }).then(response => { oidcFinished = true; return response; });
	await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
	const credentials = { email: "owner@example.com", password: "existing-password-123" };
	expect((await request("sign-up/email", { ...credentials, name: "Owner" })).status).toBe(200);
	const login = await request("sign-in/email", credentials);
	expect(login.status).toBe(200);
	const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
	expect(await (await request("get-session", undefined, cookie)).json()).toMatchObject({ user: { email: credentials.email } });
	expect(await auth.sessionReader.readSession({ url: new URL(baseURL), cookie })).toMatchObject({ user: { email: credentials.email } });
	expect((await request("sign-in/social", { provider: "google" })).status).toBe(200);
	expect((await request("sign-out", {}, cookie)).status).toBe(200);
	expect(oidcFinished).toBe(false);

	const unavailable = await oidc;
	expect(unavailable.status).toBe(503);
	expect(await unavailable.json()).toMatchObject({ code: "OIDC_UNAVAILABLE" });
	for (let i = 0; i < 10; i++) {
		expect((await request("sign-in/social", { provider: "oidc" })).status).toBe(503);
	}
	expect(fetchMock).toHaveBeenCalledTimes(1);
	finish(Response.json(idp.discoveryDocument()));
	await vi.waitFor(async () => expect((await request("sign-in/social", { provider: "oidc" })).status).toBe(200));
	expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("retries a settled discovery failure after the cooldown without rebuilding on every request", async () => {
	const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("connection refused"));
	vi.stubGlobal("fetch", fetchMock);
	const { idp, request } = await fixture();
	for (let i = 0; i < 10; i++) {
		expect((await request("sign-in/social", { provider: "oidc" })).status).toBe(503);
	}
	expect(fetchMock).toHaveBeenCalledTimes(1);
	fetchMock.mockResolvedValue(Response.json(idp.discoveryDocument()));
	await new Promise(resolve => setTimeout(resolve, OIDC_RETRY_COOLDOWN_MS + 50));
	expect((await request("sign-in/social", { provider: "oidc" })).status).toBe(200);
	expect(fetchMock).toHaveBeenCalledTimes(2);
});

async function signIn(request: Awaited<ReturnType<typeof fixture>>["request"], email = "owner@example.com") {
	const signup = await request("sign-up/email", { email, password: "existing-password-123", name: "Owner" });
	expect(signup.status).toBe(200);
	return signup.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
}

it.each(["get-access-token", "refresh-token", "account-info"])("keeps Google %s independent of failed OIDC discovery", async (endpoint) => {
	const { idp, request } = await fixture();
	const fetchMock = vi.fn<typeof fetch>(async (input) => {
		if (String(input) === idp.discoveryUrl) throw new TypeError("OIDC down");
		expect(String(input)).toBe("https://oauth2.googleapis.com/token");
		return Response.json({ access_token: "refreshed-google-token", expires_in: 3600, token_type: "Bearer" });
	});
	vi.stubGlobal("fetch", fetchMock);
	const cookie = await signIn(request);
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const idToken = `${encode({ alg: "RS256" })}.${encode({ sub: "google-user", email: "owner@example.com", email_verified: true, name: "Owner" })}.signature`;
	await client.execute({
		sql: "UPDATE account SET provider_id = 'google', access_token = 'google-token', refresh_token = 'google-refresh', access_token_expires_at = ?, id_token = ?",
		args: [Date.now() + 3600_000, idToken],
	});
	const accountId = (await client.execute("SELECT id FROM account")).rows[0]!.id as string;
	// Establish a real initialization failure before exercising a different provider.
	expect((await request("sign-in/social", { provider: "oidc" })).status).toBe(503);
	fetchMock.mockClear();
	const response = endpoint === "account-info"
		? await request(`account-info?accountId=${accountId}`, undefined, cookie)
		: await request(endpoint, { accountId }, cookie);
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject(endpoint === "account-info"
		? { user: { email: "owner@example.com" } }
		: { accessToken: endpoint === "refresh-token" ? "refreshed-google-token" : "google-token" });
	expect(fetchMock).toHaveBeenCalledTimes(endpoint === "refresh-token" ? 1 : 0);
});

it("resolves only the authenticated user's OIDC accounts, including bearer sessions", async () => {
	const { request, auth } = await fixture();
	const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("OIDC down"));
	vi.stubGlobal("fetch", fetchMock);
	const cookie = await signIn(request);
	await client.execute("UPDATE account SET provider_id = 'oidc'");
	const accountId = (await client.execute("SELECT id FROM account")).rows[0]!.id as string;
	// Free the allowlisted email to create a second user with a distinct session.
	await client.execute("UPDATE user SET email = 'other@example.com'");
	const otherCookie = await signIn(request);
	for (const unauthorizedCookie of ["", otherCookie]) {
		const response = await request("get-access-token", { accountId }, unauthorizedCookie);
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(response.status).not.toBe(503);
	}
	expect((await request("get-access-token", { useAccountCookie: true }, cookie)).status).toBe(400);
	expect(fetchMock).not.toHaveBeenCalled();
	const token = (await client.execute("SELECT token FROM session WHERE user_id = (SELECT user_id FROM account WHERE id = ?)", [accountId])).rows[0]!.token;
	const response = await auth.authHttpHandler(new Request(`${baseURL}/api/auth/get-access-token`, {
		method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
		body: JSON.stringify({ accountId }),
	}));
	expect(response.status).toBe(503);
	expect(fetchMock).toHaveBeenCalledTimes(1);
});
