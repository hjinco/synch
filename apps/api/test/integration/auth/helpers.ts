import { expect } from "vitest";

import { createRuntimeApp } from "../../../src/runtime";

export type RuntimeTestEnv = Omit<
	Env,
	"AUTH_ALLOWED_EMAILS" | "AUTH_EMAIL_FROM" | "DEV_MODE" | "EMAIL"
> & {
	AUTH_ALLOWED_EMAILS?: string;
	EMAIL?: SendEmail;
	AUTH_EMAIL_FROM?: string;
	DEV_MODE?: boolean | string;
	WWW_BASE_URL?: string;
	// Mirrors CloudflareRuntimeEnv's (src/runtime/http.ts) additions on top of the
	// wrangler-generated Env, which does not declare these: they are read directly
	// off `env` by parseCloudflareHttpConfig rather than through wrangler.jsonc vars.
	OIDC_DISCOVERY_URL?: string;
	OIDC_CLIENT_ID?: string;
	OIDC_CLIENT_SECRET?: string;
	OIDC_PROVIDER_NAME?: string;
	OIDC_SCOPES?: string;
	OIDC_ACCOUNT_ISSUER?: string;
	AUTH_EMAIL_PASSWORD?: string;
};

export function expectDeviceVerificationUrl(value: string | undefined): URL {
	expect(value).toBeTruthy();
	const url = new URL(value ?? "");
	const apiBaseUrl = new URL(process.env.BETTER_AUTH_URL ?? "");

	expect(url.origin).toBe(apiBaseUrl.origin);
	expect(url.pathname).toBe("/device");

	return url;
}

export function apiAuthPageHeaders(): Record<string, string> {
	const origin = new URL(process.env.BETTER_AUTH_URL ?? "").origin;
	return {
		origin,
		referer: `${origin}/device`,
	};
}

export async function requestWithEnv(
	path: string,
	testEnv: RuntimeTestEnv,
	init: RequestInit = {},
): Promise<Response> {
	const url = new URL(path, process.env.BETTER_AUTH_URL);
	const headers = new Headers(init.headers ?? {});
	if (!headers.has("origin")) {
		headers.set("origin", url.origin);
	}
	if (!headers.has("referer")) {
		headers.set("referer", `${url.origin}/`);
	}

	const request = new Request(url.toString(), {
		...init,
		headers,
	});

	return await createRuntimeApp(testEnv, request).fetch(request);
}
