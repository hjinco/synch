import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAuthFeature, type AuthFeature } from "../composition/features/create-auth-feature";
import type { AuthFeatureConfig } from "./better-auth";
import { createLibsqlDb } from "../db/client";
import { parseNodeServerConfig } from "../config/node";

const baseURL = "http://localhost:8787";
let client: Client;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
});
afterEach(() => { client.close(); vi.unstubAllGlobals(); });

function feature(
  provider: "google" | "github",
  clientId?: string,
  clientSecret?: string,
  options: Partial<Pick<AuthFeatureConfig, "emailVerification" | "devMode" | "email">> = {},
): AuthFeature {
  const config = parseNodeServerConfig({
    BETTER_AUTH_SECRET: "a-long-test-secret-with-at-least-32-characters",
    SYNC_TOKEN_SECRET: "sync-secret",
    AUTH_ALLOWED_EMAILS: "owner@example.com",
    [`${provider.toUpperCase()}_CLIENT_ID`]: clientId,
    [`${provider.toUpperCase()}_CLIENT_SECRET`]: clientSecret,
  });
  return createAuthFeature(createLibsqlDb(client), {
    baseURL,
    trustedOrigins: [baseURL],
    emailVerification: "disabled",
    devMode: false,
    email: { send: async () => {} },
    emailFrom: "Synch <noreply@example.com>",
    ...options,
    secret: config.betterAuthSecret,
    googleClientId: config.googleClientId,
    googleClientSecret: config.googleClientSecret,
    githubClientId: config.githubClientId,
    githubClientSecret: config.githubClientSecret,
    allowedEmails: config.authAllowedEmails,
  }, [{
    id: "test-origin-checks",
    // Better Auth skips origin validation by default under NODE_ENV=test.
    init: () => ({ context: { skipOriginCheck: false } }),
  }]);
}

function start(provider: "google" | "github", auth: AuthFeature, callbackURL = `${baseURL}/device?user_code=ABCD`) {
  return auth.authHttpHandler(new Request(`${baseURL}/api/auth/sign-in/social`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseURL },
    body: JSON.stringify({
      provider, callbackURL, disableRedirect: true,
      errorCallbackURL: `${baseURL}/signin?return_to=${encodeURIComponent(callbackURL)}`,
    }),
  }));
}

async function completeOAuth(
  provider: "google" | "github",
  auth: AuthFeature,
  email: string,
  emailVerified = true,
) {
  const signIn = await start(provider, auth);
  const { url } = await signIn.json() as { url: string };
  const state = new URL(url).searchParams.get("state")!;
  const cookie = signIn.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  // Only external provider responses are mocked; callback state,
  // database hooks, account creation, and session cookies use Better Auth.
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = `${encode({ alg: "RS256" })}.${encode({
    sub: "google-user", email, email_verified: emailVerified, name: "Google User",
    aud: "client", iss: "https://accounts.google.com", exp: Math.floor(Date.now() / 1000) + 3600,
  })}.test-signature`;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/token") || String(input).endsWith("/access_token")) {
      expect(new URLSearchParams(String(init?.body)).get("redirect_uri"))
        .toBe(`${baseURL}/v1/auth/callback/${provider}`);
    }
    if (provider === "github") {
      switch (String(input)) {
        case "https://github.com/login/oauth/access_token":
          return Response.json({ access_token: "test-access-token", token_type: "Bearer", scope: "read:user,user:email" });
        case "https://api.github.com/user":
          return Response.json({ id: 123, login: "owner", name: "GitHub User", email: null });
        case "https://api.github.com/user/emails":
          return Response.json([{ email, primary: true, verified: emailVerified }]);
        default: throw new Error(`Unexpected provider request: ${input}`);
      }
    }
    expect(String(input)).toBe("https://oauth2.googleapis.com/token");
    return Response.json({ access_token: "test-access-token", token_type: "Bearer", expires_in: 3600, id_token: token });
  });
  vi.stubGlobal("fetch", fetchMock);
  const callback = await auth.authHttpHandler(new Request(
    `${baseURL}/api/auth/callback/${provider}?state=${encodeURIComponent(state)}&code=test-code`,
    { headers: { cookie } },
  ));
  expect(fetchMock).toHaveBeenCalledTimes(provider === "google" ? 1 : 3);
  return callback;
}

describe.each(["google", "github"] as const)("optional %s authentication", (provider) => {
  it.each([
    [undefined, undefined], ["client", undefined], [undefined, "secret"],
    [" ", "secret"], ["client", "  "],
  ])("disables discovery and direct sign-in for incomplete credentials (%s, %s)", async (id, secret) => {
    const auth = feature(provider, id, secret);
    const response = await auth.authHttpHandler(new Request(`${baseURL}/api/auth/providers`));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ google: false, github: false, emailAndPassword: true, oidc: null });
    const signIn = await start(provider, auth);
    expect(signIn.status).toBe(404);
    expect(await signIn.json()).toMatchObject({ code: "PROVIDER_NOT_FOUND" });
  });

  it("publishes only availability and starts OAuth with the configured callback", async () => {
    const auth = feature(provider, " client-id ", " client-secret ");
    const response = await auth.authHttpHandler(new Request(`${baseURL}/api/auth/providers`));
    expect(await response.json()).toEqual({ google: provider === "google", github: provider === "github", emailAndPassword: true, oidc: null });
    const signIn = await start(provider, auth);
    expect(signIn.status).toBe(200);
    expect(signIn.headers.get("set-cookie") ?? "").not.toContain("last_used_login_method");
    const body = await signIn.json() as { url: string; redirect: boolean };
    const url = new URL(body.url);
    expect(url.origin).toBe(provider === "google" ? "https://accounts.google.com" : "https://github.com");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(`${baseURL}/v1/auth/callback/${provider}`);
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(body.redirect).toBe(false);
    expect(body.url).not.toContain("client-secret");

    const cookie = signIn.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const canceled = await auth.authHttpHandler(new Request(
      `${baseURL}/api/auth/callback/${provider}?state=${encodeURIComponent(url.searchParams.get("state")!)}&error=access_denied`,
      { headers: { cookie } },
    ));
    expect(canceled.status).toBe(302);
    expect(canceled.headers.get("set-cookie") ?? "").not.toContain("last_used_login_method");
    const returnUrl = new URL(canceled.headers.get("location")!);
    expect(returnUrl.pathname).toBe("/signin");
    expect(returnUrl.searchParams.get("error")).toBe("access_denied");
    expect(returnUrl.searchParams.get("return_to")).toBe(`${baseURL}/device?user_code=ABCD`);
  });

  it.each(["owner@example.com", "denied@example.com"])("applies account creation policy after OAuth for %s", async (email) => {
    const auth = feature(provider, "client", "secret");
    const callback = await completeOAuth(provider, auth, email);
    expect(callback.status).toBe(302);
    const users = await client.execute("SELECT email FROM user");
    if (email === "owner@example.com") {
      expect(callback.headers.get("location")).toBe(`${baseURL}/device?user_code=ABCD`);
      expect(callback.headers.get("set-cookie")).toContain("better-auth.session_token=");
      const methodCookie = callback.headers.getSetCookie().find((cookie) => cookie.startsWith("better-auth.last_used_login_method="));
      expect(methodCookie).toContain(`=${provider};`);
      expect(methodCookie).toMatch(/max-age=2592000/i);
      expect(methodCookie).not.toMatch(/httponly/i);
      expect(users.rows).toHaveLength(1);
      expect((await client.execute("SELECT id FROM organization")).rows).toHaveLength(1);
      expect((await client.execute("SELECT active_organization_id FROM session")).rows[0]?.active_organization_id).toBeTruthy();
    } else {
      expect(new URL(callback.headers.get("location")!).pathname).toBe("/signin");
      expect(users.rows).toHaveLength(0);
      expect((await client.execute("SELECT id FROM session")).rows).toHaveLength(0);
      expect(callback.headers.get("set-cookie") ?? "").not.toContain("last_used_login_method");
    }
  });

  it.each([
    { emailVerification: "disabled", returning: false },
    { emailVerification: "required", returning: false },
    { emailVerification: "disabled", returning: true },
    { emailVerification: "required", returning: true },
  ] as const)("rejects unverified provider email without side effects: %j", async ({ emailVerification, returning }) => {
    const send = vi.fn(async () => {});
    const auth = feature(provider, "client", "secret", { emailVerification, email: { send } });
    if (returning) {
      const firstLogin = await completeOAuth(provider, auth, "owner@example.com");
      expect(firstLogin.headers.get("location")).toBe(`${baseURL}/device?user_code=ABCD`);
    }
    const snapshot = async () => Promise.all(
      ["user", "account", "organization", "member", "session"].map(async (table) =>
        (await client.execute(`SELECT * FROM ${table}`)).rows,
      ),
    );
    const before = await snapshot();
    const rejected = await completeOAuth(provider, auth, "owner@example.com", false);
    expect(rejected.status).toBe(302);
    const destination = new URL(rejected.headers.get("location")!);
    expect(destination.pathname).toBe("/signin");
    expect(destination.searchParams.get("error")).toBe("email_not_verified");
    expect(rejected.headers.get("set-cookie") ?? "").not.toContain("session_token=");
    expect(rejected.headers.get("set-cookie") ?? "").not.toContain("last_used_login_method");
    expect(await snapshot()).toEqual(before);
    expect(send).not.toHaveBeenCalled();

    const verified = await completeOAuth(provider, auth, "owner@example.com", true);
    expect(verified.headers.get("location")).toBe(`${baseURL}/device?user_code=ABCD`);
    expect(verified.headers.get("set-cookie")).toContain("better-auth.session_token=");
  });

  it.each([
    { emailVerification: "disabled", devMode: false, providerVerified: true, localVerified: false, links: true },
    { emailVerification: "disabled", devMode: false, providerVerified: false, localVerified: false, links: false },
    { emailVerification: "required", devMode: false, providerVerified: true, localVerified: false, links: false },
    { emailVerification: "required", devMode: true, providerVerified: true, localVerified: false, links: false },
    { emailVerification: "required", devMode: false, providerVerified: true, localVerified: true, links: true },
  ] as const)("links an existing account according to verification policy: %j", async ({ emailVerification, devMode, providerVerified, localVerified, links }) => {
    const auth = feature(provider, "client", "secret", { emailVerification, devMode });
    const email = "owner@example.com";
    const signUp = await auth.authHttpHandler(new Request(`${baseURL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseURL },
      body: JSON.stringify({ name: "Existing Owner", email, password: "existing-owner-password" }),
    }));
    expect(signUp.status).toBe(200);
    const originalUser = (await client.execute("SELECT id, email_verified FROM user")).rows[0]!;
    expect(originalUser.email_verified).toBe(0);
    if (localVerified) await client.execute("UPDATE user SET email_verified = 1");
    const originalOrganizations = (await client.execute("SELECT * FROM organization")).rows;
    const originalMembers = (await client.execute("SELECT * FROM member")).rows;
    const originalSessions = (await client.execute("SELECT id FROM session")).rows;

    const callback = await completeOAuth(provider, auth, email, providerVerified);
    expect(callback.status).toBe(302);
    if (links) {
      expect(callback.headers.get("location")).toBe(`${baseURL}/device?user_code=ABCD`);
      const sessionResponse = await auth.authHttpHandler(new Request(`${baseURL}/api/auth/get-session`, {
        headers: { cookie: callback.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ") },
      }));
      expect(await sessionResponse.json()).toMatchObject({
        user: { id: originalUser.id, emailVerified: true },
        session: { userId: originalUser.id, activeOrganizationId: originalOrganizations[0]!.id },
      });
      expect((await client.execute("SELECT provider_id, user_id FROM account ORDER BY provider_id")).rows).toEqual([
        { provider_id: "credential", user_id: originalUser.id },
        { provider_id: provider, user_id: originalUser.id },
      ]);
      // The linked provider must also work on subsequent visits.
      const nextLogin = await completeOAuth(provider, auth, email);
      expect(nextLogin.headers.get("location")).toBe(`${baseURL}/device?user_code=ABCD`);
      expect(nextLogin.headers.get("set-cookie")).toContain("better-auth.session_token=");
    } else {
      expect(new URL(callback.headers.get("location")!).searchParams.get("error")).toBe("account_not_linked");
      expect((await client.execute("SELECT provider_id FROM account")).rows).toEqual([{ provider_id: "credential" }]);
      expect((await client.execute("SELECT id FROM session")).rows).toEqual(originalSessions);
    }
    expect((await client.execute("SELECT id FROM user")).rows).toEqual([{ id: originalUser.id }]);
    expect((await client.execute("SELECT * FROM organization")).rows).toEqual(originalOrganizations);
    expect((await client.execute("SELECT * FROM member")).rows).toEqual(originalMembers);
  });

  it.each(["disabled", "required"] as const)("rejects password sign-up for an existing social account with verification %s", async (emailVerification) => {
    const send = vi.fn(async () => {});
    const auth = feature(provider, "client", "secret", { emailVerification, email: { send } });
    const callback = await completeOAuth(provider, auth, "owner@example.com");
    expect(callback.headers.get("location")).toBe(`${baseURL}/device?user_code=ABCD`);
    const before = await client.execute("SELECT * FROM account");
    const existingUsers = await client.execute("SELECT * FROM user");
    const existingSessions = await client.execute("SELECT * FROM session");
    const duplicate = await auth.authHttpHandler(new Request(`${baseURL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseURL },
      body: JSON.stringify({ name: "Duplicate", email: "OWNER@example.com", password: "new-password-123" }),
    }));
    expect(duplicate.status).toBe(422);
    expect(await duplicate.json()).toMatchObject({ code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" });
    expect(send).not.toHaveBeenCalled();
    expect(duplicate.headers.get("set-cookie") ?? "").not.toContain("last_used_login_method");
    expect((await client.execute("SELECT * FROM account")).rows).toEqual(before.rows);
    expect((await client.execute("SELECT * FROM user")).rows).toEqual(existingUsers.rows);
    expect((await client.execute("SELECT * FROM session")).rows).toEqual(existingSessions.rows);
  });

  it("rejects an untrusted post-login destination", async () => {
    const response = await start(provider, feature(provider, "client", "secret"), "https://untrusted.example/device");
    expect(response.status).toBe(403);
  });
});

it("records email authentication only after success and preserves the hint on sign-out", async () => {
  const auth = feature("google");
  const emailRequest = (path: string, body: unknown, cookie = "") => auth.authHttpHandler(new Request(`${baseURL}/api/auth/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseURL, cookie },
    body: JSON.stringify(body),
  }));
  const credentials = { email: "owner@example.com", password: "password-123" };
  const signUp = await emailRequest("sign-up/email", { ...credentials, name: "Owner" });
  expect(signUp.status).toBe(200);
  expect(signUp.headers.get("set-cookie")).toContain("better-auth.last_used_login_method=email;");
  const signIn = await emailRequest("sign-in/email", credentials);
  expect(signIn.status).toBe(200);
  expect(signIn.headers.get("set-cookie")).toContain("better-auth.last_used_login_method=email;");
  const failed = await emailRequest("sign-in/email", { ...credentials, password: "wrong-password" });
  expect(failed.status).toBe(401);
  expect(failed.headers.get("set-cookie") ?? "").not.toContain("last_used_login_method");
  const signOut = await emailRequest("sign-out", {}, signIn.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; "));
  expect(signOut.status).toBe(200);
  expect(signOut.headers.get("set-cookie") ?? "").not.toContain("last_used_login_method");
});
