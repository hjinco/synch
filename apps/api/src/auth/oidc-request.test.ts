import { expect, it, vi } from "vitest";
import { isOidcRequest } from "./oidc-request";

it.each([
	["/callback/oidc", "GET", undefined, true],
	["/callback/oidc/", "POST", undefined, true],
	["/callback/google", "GET", undefined, false],
	["/get-session", "GET", undefined, false],
	["/sign-out", "POST", {}, false],
	["/device/token", "POST", {}, false],
	["/sign-in/email", "POST", { provider: "oidc" }, false],
	["/sign-in/social", "POST", { provider: "oidc" }, true],
	["/sign-in/social/", "POST", { provider: "google" }, false],
	["/link-social", "POST", { provider: "oidc" }, true],
	["/get-access-token", "POST", { accountId: "oidc-account" }, true],
	["/refresh-token", "POST", { accountId: "github-account" }, false],
	["/refresh-token", "POST", { accountId: "unknown-account" }, false],
	["/account-info?accountId=oidc-account", "GET", undefined, true],
	["/account-info?accountId=google-account", "GET", undefined, false],
	["/account-info?accountId=unknown-account", "GET", undefined, false],
	["/get-access-token", "POST", { useAccountCookie: true }, false],
] as const)("selects provider-dependent requests: %s %s %j", async (path, method, body, expected) => {
	const url = new URL(`https://synch.example/api/auth${path}`);
	const request = new Request(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	expect(await isOidcRequest(request, url.pathname, async (id) => id === "unknown-account" ? undefined : id.split("-")[0])).toBe(expected);
	if (body) expect(await request.json()).toEqual(body);
});

it("recognizes form-encoded OAuth requests without consuming the body", async () => {
	const request = new Request("https://synch.example/api/auth/sign-in/social", { method: "POST", body: new URLSearchParams({ provider: "oidc" }) });
	expect(await isOidcRequest(request, new URL(request.url).pathname, vi.fn())).toBe(true);
	expect(await request.text()).toBe("provider=oidc");
});
