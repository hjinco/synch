import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as oidcDiagnostics from "../auth/oidc-diagnostics";
import {
	MissingOidcVariablesError,
	parseOidcProviderConfig,
} from "../auth/policies/oidc";
import {
	type CloudflareRuntimeEnv,
	parseBooleanBinding,
	parseCloudflareHttpConfig,
	readCloudflareProfile,
} from "./cloudflare";

describe("Cloudflare config", () => {
	it("maps the legacy SELF_HOSTED binding to an explicit deployment profile", () => {
		expect(readCloudflareProfile({ SELF_HOSTED: true })).toEqual({
			platform: "cloudflare",
			edition: "community",
		});
		expect(readCloudflareProfile({ SELF_HOSTED: false })).toEqual({
			platform: "cloudflare",
			edition: "managed",
		});
	});

	it("parses supported boolean binding representations", () => {
		expect(parseBooleanBinding("FLAG", "true", false)).toBe(true);
		expect(parseBooleanBinding("FLAG", "1", false)).toBe(true);
		expect(parseBooleanBinding("FLAG", "false", true)).toBe(false);
		expect(parseBooleanBinding("FLAG", "0", true)).toBe(false);
		expect(parseBooleanBinding("FLAG", undefined, true)).toBe(true);
	});

	it("rejects ambiguous boolean bindings", () => {
		expect(() => parseBooleanBinding("FLAG", "yes", false)).toThrow();
	});
});

describe("Cloudflare HTTP config OIDC and password-auth bindings", () => {
	const request = new Request("https://example.com");

	const communityEnv = {
		SELF_HOSTED: true,
		AUTH_ALLOWED_EMAILS: "owner@example.com",
	} as unknown as CloudflareRuntimeEnv;

	const fullOidcEnv = {
		OIDC_DISCOVERY_URL: "https://idp.example.com/oidc",
		OIDC_CLIENT_ID: "test-client-id",
		OIDC_CLIENT_SECRET: "test-client-secret",
	};

	it("resolves an OidcProviderConfig from a full binding set", () => {
		const env = {
			...communityEnv,
			...fullOidcEnv,
		} as unknown as CloudflareRuntimeEnv;

		const config = parseCloudflareHttpConfig(env, request);

		expect(config.oidc).toEqual(
			parseOidcProviderConfig({
				discoveryUrl: fullOidcEnv.OIDC_DISCOVERY_URL,
				clientId: fullOidcEnv.OIDC_CLIENT_ID,
				clientSecret: fullOidcEnv.OIDC_CLIENT_SECRET,
			}),
		);
	});

	it("leaves oidc undefined when no OIDC bindings are set", () => {
		const config = parseCloudflareHttpConfig(communityEnv, request);

		expect(config).toEqual({
			profile: { platform: "cloudflare", edition: "community" },
			capabilities: {
				billing: "disabled",
				emailVerification: "disabled",
				signUpAccess: "allowlist",
				backgroundJobs: "inline",
			},
			authBaseUrl: "https://example.com",
			publicOrigin: "https://example.com",
			corsOrigin: "http://localhost:4321",
			devMode: false,
			polarSandbox: false,
			emailAndPassword: "enabled",
			oidc: undefined,
		});
	});

	it("throws when the Cloudflare OIDC bindings are partially set", () => {
		const env = {
			...communityEnv,
			OIDC_CLIENT_ID: fullOidcEnv.OIDC_CLIENT_ID,
		} as unknown as CloudflareRuntimeEnv;

		let caught: unknown;
		try {
			parseCloudflareHttpConfig(env, request);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(MissingOidcVariablesError);
		expect((caught as MissingOidcVariablesError).missing).toEqual([
			"OIDC_DISCOVERY_URL",
			"OIDC_CLIENT_SECRET",
		]);
	});

	it("requires AUTH_ALLOWED_EMAILS only when password auth is enabled", () => {
		// Omit AUTH_ALLOWED_EMAILS explicitly: this assertion is about its absence,
		// not merely about whatever the shared fixture happens to include.
		const { AUTH_ALLOWED_EMAILS: _omit, ...envWithoutAllowedEmails } =
			communityEnv as unknown as Record<string, unknown>;

		expect(() =>
			parseCloudflareHttpConfig(
				envWithoutAllowedEmails as unknown as CloudflareRuntimeEnv,
				request,
			),
		).toThrow();

		const passwordDisabledEnv = {
			...envWithoutAllowedEmails,
			AUTH_EMAIL_PASSWORD: "disabled",
		} as unknown as CloudflareRuntimeEnv;

		expect(() =>
			parseCloudflareHttpConfig(passwordDisabledEnv, request),
		).not.toThrow();
	});

	it("rejects an AUTH_EMAIL_PASSWORD value that is neither enabled nor disabled", () => {
		const env = {
			...communityEnv,
			AUTH_EMAIL_PASSWORD: "sometimes",
		} as unknown as CloudflareRuntimeEnv;

		expect(() => parseCloudflareHttpConfig(env, request)).toThrow();
	});

	describe("partial OIDC config diagnostics", () => {
		let recordSpy: ReturnType<typeof vi.spyOn>;

		beforeEach(() => {
			oidcDiagnostics.resetOidcDiagnosticsStateForTests();
			recordSpy = vi.spyOn(oidcDiagnostics, "recordOidcDiagnostic");
		});

		afterEach(() => {
			recordSpy.mockRestore();
		});

		const partialEnv = {
			...communityEnv,
			OIDC_CLIENT_ID: fullOidcEnv.OIDC_CLIENT_ID,
		} as unknown as CloudflareRuntimeEnv;

		it("names the missing variables through the bounded diagnostic channel, not a raw per-request log", () => {
			expect(() => parseCloudflareHttpConfig(partialEnv, request)).toThrow(
				MissingOidcVariablesError,
			);

			expect(recordSpy).toHaveBeenCalledTimes(1);
			const [, detail] = recordSpy.mock.calls[0] ?? [];
			expect(detail).toMatchObject({
				missing: ["OIDC_DISCOVERY_URL", "OIDC_CLIENT_SECRET"],
			});
			// The must-NOT-log half: the one secret this partial config DOES carry
			// (OIDC_CLIENT_ID) must never appear in the diagnostic payload, since
			// only the NAMES of missing variables -- never the values of present
			// ones -- are ever relevant to this event.
			expect(JSON.stringify(detail)).not.toContain(fullOidcEnv.OIDC_CLIENT_ID);
		});

		it("still throws (and still 500s the request) every time, even though the diagnostic itself is bounded", () => {
			expect(() => parseCloudflareHttpConfig(partialEnv, request)).toThrow();
			expect(() => parseCloudflareHttpConfig(partialEnv, request)).toThrow();
			expect(() => parseCloudflareHttpConfig(partialEnv, request)).toThrow();

			// Same misconfiguration, so it collapses to one line rather than one
			// per request -- an unfixed partial-config binding otherwise produces
			// one full log entry per request for as long as it goes unnoticed.
			expect(recordSpy).toHaveBeenCalledTimes(1);
		});
	});
});
