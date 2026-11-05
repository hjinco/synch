import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { extractCookieHeader, uniqueId } from "../../helpers/api";
import { requestWithEnv, type RuntimeTestEnv } from "./helpers";

describe("auth email/password toggle integration", () => {
	it("rejects sign-in with valid credentials once AUTH_EMAIL_PASSWORD is disabled", async () => {
		const email = `${uniqueId("password-toggle")}@example.com`;
		const password = "supersecret123";
		// DEV_MODE bypasses the managed-edition email-verification requirement so
		// this account is usable for sign-in immediately after sign-up.
		const bootstrapEnv: RuntimeTestEnv = {
			...env,
			SELF_HOSTED: false,
			DEV_MODE: true,
		};

		const signUp = await jsonRequestWithEnv<{ token: string | null }>(
			"/api/auth/sign-up/email",
			bootstrapEnv,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: "Toggle User", email, password }),
			},
		);
		expect(signUp.response.status).toBe(200);
		expect(signUp.json?.token).toBeTruthy();

		const disabledEnv: RuntimeTestEnv = {
			...bootstrapEnv,
			AUTH_EMAIL_PASSWORD: "disabled",
		};

		const signIn = await requestWithEnv("/api/auth/sign-in/email", disabledEnv, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email, password }),
		});

		// Better Auth's own reason for rejecting a disabled provider carries no
		// stable identifier this codebase owns, so this asserts the observable
		// behavior (non-2xx, no session issued) rather than an exact status code.
		expect(signIn.status).toBeGreaterThanOrEqual(400);
		expect(extractCookieHeader(signIn)).not.toContain("better-auth.session_token=");
	});

	it("does not gate sign-up when no allowlist is configured", async () => {
		const email = `${uniqueId("no-allowlist")}@example.com`;
		const testEnv: RuntimeTestEnv = {
			...env,
			SELF_HOSTED: false,
			DEV_MODE: true,
		};

		const signUp = await jsonRequestWithEnv<{ token: string | null }>(
			"/api/auth/sign-up/email",
			testEnv,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					name: "Ungated User",
					email,
					password: "supersecret123",
				}),
			},
		);

		expect(signUp.response.status).toBe(200);
		expect(signUp.json?.token).toBeTruthy();
	});

	it("boots a self-hosted (allowlist-capable) deployment with no AUTH_ALLOWED_EMAILS once password sign-up is disabled", async () => {
		// SELF_HOSTED: true is the only profile whose capabilities require an
		// allowlist at all (capabilitiesFor -> signUpAccess: "allowlist"). This is
		// the exact combination that used to be impossible to boot: the config
		// layer treats the allowlist as optional here, but runtime/http.ts kept a
		// second, independent check that ignored AUTH_EMAIL_PASSWORD entirely.
		const { AUTH_ALLOWED_EMAILS: _omit, ...envWithoutAllowedEmails } =
			env as unknown as Record<string, unknown>;
		const testEnv: RuntimeTestEnv = {
			...envWithoutAllowedEmails,
			SELF_HOSTED: true,
			DEV_MODE: true,
			AUTH_EMAIL_PASSWORD: "disabled",
		} as RuntimeTestEnv;

		const response = await requestWithEnv("/health", testEnv);

		expect(response.status).toBe(200);
	});

	it("still requires AUTH_ALLOWED_EMAILS for a self-hosted deployment when password sign-up is enabled", async () => {
		const { AUTH_ALLOWED_EMAILS: _omit, ...envWithoutAllowedEmails } =
			env as unknown as Record<string, unknown>;
		const testEnv: RuntimeTestEnv = {
			...envWithoutAllowedEmails,
			SELF_HOSTED: true,
			DEV_MODE: true,
		} as RuntimeTestEnv;

		await expect(requestWithEnv("/health", testEnv)).rejects.toThrow();
	});
});

async function jsonRequestWithEnv<T = unknown>(
	path: string,
	testEnv: RuntimeTestEnv,
	init: RequestInit = {},
): Promise<{ response: Response; json: T | null; text: string }> {
	const response = await requestWithEnv(path, testEnv, init);
	const text = await response.text();

	return {
		response,
		text,
		json: text ? (JSON.parse(text) as T) : null,
	};
}
