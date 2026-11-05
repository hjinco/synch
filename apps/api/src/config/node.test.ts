import { describe, expect, it } from "vitest";

import {
	MissingOidcVariablesError,
	parseOidcProviderConfig,
} from "../auth/policies/oidc";
import { parseNodeServerConfig } from "./node";

const requiredEnv = {
	BETTER_AUTH_SECRET: "auth-secret",
	AUTH_ALLOWED_EMAILS: "owner@example.com",
	SYNC_TOKEN_SECRET: "sync-secret",
};

const fullOidcEnv = {
	OIDC_DISCOVERY_URL: "https://idp.example.com/oidc",
	OIDC_CLIENT_ID: "test-client-id",
	OIDC_CLIENT_SECRET: "test-client-secret",
};

describe("Node server config", () => {
	it("applies Node server defaults", () => {
		const config = parseNodeServerConfig(requiredEnv);

		expect(config).toMatchObject({
			host: "0.0.0.0",
			port: 8787,
			dataDir: "./data",
			publicUrl: "http://localhost:8787",
			blob: { kind: "disk", directory: "./data/blobs" },
		});
	});

	it("keeps request timeouts finite and below staged GC expiry", () => {
		expect(parseNodeServerConfig(requiredEnv).requestTimeoutMs).toBe(300_000);
		expect(parseNodeServerConfig({ ...requiredEnv, REQUEST_TIMEOUT_MS: "900000" }))
			.toMatchObject({ requestTimeoutMs: 900_000 });
		for (const value of ["0", "-1", "1500001", "NaN"]) {
			expect(() => parseNodeServerConfig({ ...requiredEnv, REQUEST_TIMEOUT_MS: value })).toThrow();
		}
	});

	it("validates and returns an S3 configuration", () => {
		const config = parseNodeServerConfig({
			...requiredEnv,
			BLOB_STORAGE: "S3",
			S3_ENDPOINT: "https://storage.example.com",
			S3_BUCKET: "synch",
			S3_ACCESS_KEY_ID: "access-key",
			S3_SECRET_ACCESS_KEY: "secret-key",
		});

		expect(config.blob).toEqual({
			kind: "s3",
			endpoint: "https://storage.example.com",
			bucket: "synch",
			region: undefined,
			accessKeyId: "access-key",
			secretAccessKey: "secret-key",
		});
	});

	it("rejects invalid ports and incomplete S3 settings before startup", () => {
		expect(() => parseNodeServerConfig({ ...requiredEnv, PORT: "70000" })).toThrow();
		expect(() =>
			parseNodeServerConfig({ ...requiredEnv, BLOB_STORAGE: "s3" }),
		).toThrow();
	});

	it("rejects an incomplete OIDC configuration before startup", () => {
		let caught: unknown;
		try {
			parseNodeServerConfig({
				...requiredEnv,
				OIDC_DISCOVERY_URL: fullOidcEnv.OIDC_DISCOVERY_URL,
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(MissingOidcVariablesError);
		expect((caught as MissingOidcVariablesError).missing).toEqual([
			"OIDC_CLIENT_ID",
			"OIDC_CLIENT_SECRET",
		]);
	});

	it("requires AUTH_ALLOWED_EMAILS when password auth is enabled (the default)", () => {
		const { AUTH_ALLOWED_EMAILS: _omit, ...envWithoutAllowedEmails } = requiredEnv;

		expect(() => parseNodeServerConfig(envWithoutAllowedEmails)).toThrow();
	});

	it("starts without AUTH_ALLOWED_EMAILS when password auth is disabled", () => {
		const { AUTH_ALLOWED_EMAILS: _omit, ...envWithoutAllowedEmails } = requiredEnv;

		const config = parseNodeServerConfig({
			...envWithoutAllowedEmails,
			AUTH_EMAIL_PASSWORD: "disabled",
		});

		// Absence must be representable as `undefined`, not collapsed into "" --
		// otherwise "not configured" and "configured but empty" become the same
		// value, which is exactly the ambiguity a later refactor could turn into
		// a security bug.
		expect(config.authAllowedEmails).toBeUndefined();
		expect(config.emailAndPassword).toBe("disabled");
	});

	it("defaults emailAndPassword to enabled", () => {
		const config = parseNodeServerConfig(requiredEnv);

		expect(config.emailAndPassword).toBe("enabled");
	});

	it("rejects AUTH_EMAIL_PASSWORD values other than enabled or disabled", () => {
		expect(() =>
			parseNodeServerConfig({ ...requiredEnv, AUTH_EMAIL_PASSWORD: "sometimes" }),
		).toThrow();
	});

	it("resolves an OidcProviderConfig from a full OIDC env set", () => {
		const config = parseNodeServerConfig({ ...requiredEnv, ...fullOidcEnv });

		expect(config.oidc).toEqual(
			parseOidcProviderConfig({
				discoveryUrl: fullOidcEnv.OIDC_DISCOVERY_URL,
				clientId: fullOidcEnv.OIDC_CLIENT_ID,
				clientSecret: fullOidcEnv.OIDC_CLIENT_SECRET,
			}),
		);
	});

	it("leaves oidc undefined when no OIDC environment variables are set", () => {
		const config = parseNodeServerConfig(requiredEnv);

		expect(config.oidc).toBeUndefined();
	});
});
