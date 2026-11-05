import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { requestWithEnv } from "./helpers";

describe.each(["google", "github"] as const)("Cloudflare %s credentials", (provider) => {
  it.each([
    [undefined, undefined, false],
    ["client-id", undefined, false],
    [undefined, "client-secret", false],
    ["client-id", " ", false],
    [" client-id ", " client-secret ", true],
  ] as const)("enables the provider only with both credentials (%s, %s)", async (id, secret, enabled) => {
    const testEnv = {
      ...env,
      SELF_HOSTED: true as const,
      AUTH_ALLOWED_EMAILS: "owner@example.com",
      GOOGLE_CLIENT_ID: provider === "google" ? id : undefined,
      GOOGLE_CLIENT_SECRET: provider === "google" ? secret : undefined,
      GITHUB_CLIENT_ID: provider === "github" ? id : undefined,
      GITHUB_CLIENT_SECRET: provider === "github" ? secret : undefined,
    };
    const response = await requestWithEnv("/api/auth/providers", testEnv);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ google: provider === "google" && enabled, github: provider === "github" && enabled, emailAndPassword: true, oidc: null });
    const signIn = await requestWithEnv("/api/auth/sign-in/social", testEnv, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, disableRedirect: true }),
    });
    expect(signIn.status).toBe(enabled ? 200 : 404);
    if (enabled) {
      const body = await signIn.json() as { url: string };
      expect(new URL(body.url).searchParams.get("client_id")).toBe("client-id");
    }
  });
});

it("enables Google and GitHub together without publishing their credentials", async () => {
  const response = await requestWithEnv("/api/auth/providers", {
    ...env,
    SELF_HOSTED: true,
    AUTH_ALLOWED_EMAILS: "owner@example.com",
    ...{
      GOOGLE_CLIENT_ID: "google-client", GOOGLE_CLIENT_SECRET: "google-secret",
      GITHUB_CLIENT_ID: "github-client", GITHUB_CLIENT_SECRET: "github-secret",
    },
  });
  expect(await response.json()).toEqual({ google: true, github: true, emailAndPassword: true, oidc: null });
});
