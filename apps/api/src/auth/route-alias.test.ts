import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAuthFeature } from "../composition/features/create-auth-feature";
import { createLibsqlDb } from "../db/client";
import { registerAuthRoutes } from "./routes";

const origin = "http://localhost:8787";
let client: Client;
let app: Hono;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
  const auth = createAuthFeature(createLibsqlDb(client), {
    baseURL: origin,
    trustedOrigins: [origin],
    secret: "a-long-test-secret-with-at-least-32-characters",
    emailVerification: "disabled",
    devMode: false,
    googleClientId: "google-client",
    googleClientSecret: "google-secret",
    githubClientId: "github-client",
    githubClientSecret: "github-secret",
  }, [{
    id: "test-origin-checks",
    init: () => ({ context: { skipOriginCheck: false } }),
  }]);
  app = new Hono();
  registerAuthRoutes(app, auth.authHttpHandler, origin);
});
afterEach(() => client.close());

function request(path: string, body?: unknown, cookie?: string, method?: string) {
  return app.request(`${origin}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      origin,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function cookies(response: Response) {
  return response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
}

describe.each(["/api/auth", "/v1/auth"])("authentication via %s", (basePath) => {
  const otherPath = basePath === "/api/auth" ? "/v1/auth" : "/api/auth";

  it("shares accounts, session cookies, and sign-out across both paths", async () => {
    const signUp = await request(`${basePath}/sign-up/email`, {
      name: "Alias User", email: "alias@example.com", password: "test-password-123",
    });
    expect(signUp.status).toBe(200);
    const cookie = cookies(signUp);
    const session = await request(`${otherPath}/get-session`, undefined, cookie);
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ user: { email: "alias@example.com" } });
    expect((await request(`${otherPath}/sign-out`, {}, cookie)).status).toBe(200);
    expect(await (await request(`${basePath}/get-session`, undefined, cookie)).json()).toBeNull();
    expect((await request(`${otherPath}/sign-in/email`, {
      email: "alias@example.com", password: "test-password-123",
    })).status).toBe(200);
  });

  it("exposes provider availability and preserves organization API restrictions", async () => {
    expect(await (await request(`${basePath}/providers`)).json()).toEqual({ google: true, github: true, emailAndPassword: true, oidc: null });
    for (const path of ["organization/create", "organization/%63reate"]) {
      const response = await request(`${basePath}/${path}`, { name: "Blocked" });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "use_organization_api" });
    }
  });

  it.each(["google", "github"])("preserves canonical %s callbacks and accepts callbacks on either route", async (provider) => {
    const callbackURL = `${origin}/device?user_code=ABCD`;
    const response = await request(`${basePath}/sign-in/social`, {
      provider, callbackURL, disableRedirect: true,
      errorCallbackURL: `${origin}/signin?return_to=${encodeURIComponent(callbackURL)}`,
    });
    expect(response.status).toBe(200);
    const { url } = await response.json() as { url: string };
    const authorization = new URL(url);
    expect(authorization.searchParams.get("redirect_uri")).toBe(`${origin}/v1/auth/callback/${provider}`);
    const state = authorization.searchParams.get("state")!;
    const callback = await request(
      `${otherPath}/callback/${provider}?state=${encodeURIComponent(state)}&error=access_denied`,
      undefined, cookies(response),
    );
    expect(callback.status).toBe(302);
    const destination = new URL(callback.headers.get("location")!);
    expect(destination.pathname).toBe("/signin");
    expect(destination.searchParams.get("return_to")).toBe(callbackURL);
    expect(destination.searchParams.get("error")).toBe("access_denied");
  });

  it("rejects untrusted OAuth destinations on both paths", async () => {
    const response = await request(`${basePath}/sign-in/social`, {
      provider: "google", callbackURL: "https://untrusted.example", disableRedirect: true,
    });
    expect(response.status).toBe(403);
  });
});
