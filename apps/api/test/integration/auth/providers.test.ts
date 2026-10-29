import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { apiRequest } from "../../helpers/api";
import { createFakeIdp, type FakeIdp } from "../../helpers/fake-idp";
import { installFakeIdpFetch } from "./fake-idp-fetch";
import { requestWithEnv, type RuntimeTestEnv } from "./helpers";

type ProvidersResponse = {
	google: boolean;
	github: boolean;
	emailAndPassword: boolean;
	oidc: { providerId: string; name: string } | null;
};

describe("GET /v1/auth/providers", () => {
	it("reports the configured OIDC provider by id and display name", async () => {
		const idp = await setUpFakeIdp();
		const testEnv: RuntimeTestEnv = {
			...env,
			OIDC_DISCOVERY_URL: idp.discoveryUrl,
			OIDC_CLIENT_ID: crypto.randomUUID(),
			OIDC_CLIENT_SECRET: crypto.randomUUID(),
			OIDC_PROVIDER_NAME: "Pocket ID",
		};

		const response = await requestWithEnv("/v1/auth/providers", testEnv);
		const body = (await response.json()) as ProvidersResponse;

		expect(response.status).toBe(200);
		expect(body).toStrictEqual({
			google: false,
			github: false,
			emailAndPassword: true,
			oidc: { providerId: "oidc", name: "Pocket ID" },
		});
	});

	it("reports oidc: null when OIDC is not configured", async () => {
		const testEnv: RuntimeTestEnv = {
			...env,
			OIDC_DISCOVERY_URL: undefined,
			OIDC_CLIENT_ID: undefined,
			OIDC_CLIENT_SECRET: undefined,
		};

		const response = await requestWithEnv("/v1/auth/providers", testEnv);
		const body = (await response.json()) as ProvidersResponse;

		expect(response.status).toBe(200);
		expect(body).toStrictEqual({
			google: false,
			github: false,
			emailAndPassword: true,
			oidc: null,
		});
	});

	it("reports emailAndPassword: false when password auth is disabled", async () => {
		const testEnv: RuntimeTestEnv = {
			...env,
			OIDC_DISCOVERY_URL: undefined,
			OIDC_CLIENT_ID: undefined,
			OIDC_CLIENT_SECRET: undefined,
			AUTH_EMAIL_PASSWORD: "disabled",
		};

		const response = await requestWithEnv("/v1/auth/providers", testEnv);
		const body = (await response.json()) as ProvidersResponse;

		expect(response.status).toBe(200);
		expect(body).toStrictEqual({
			google: false,
			github: false,
			emailAndPassword: false,
			oidc: null,
		});
	});

	it("never serializes the client secret, client ID, or discovery URL", async () => {
		const idp = await setUpFakeIdp();
		const clientSecret = crypto.randomUUID();
		const clientId = crypto.randomUUID();
		const discoveryUrl = idp.discoveryUrl;
		const testEnv: RuntimeTestEnv = {
			...env,
			OIDC_DISCOVERY_URL: discoveryUrl,
			OIDC_CLIENT_ID: clientId,
			OIDC_CLIENT_SECRET: clientSecret,
			OIDC_PROVIDER_NAME: "Pocket ID",
		};

		const response = await requestWithEnv("/v1/auth/providers", testEnv);
		const text = await response.text();

		expect(response.status).toBe(200);

		// PRIMARY: an exact shape match fails on any extra key, so an accidental
		// spread of the whole OidcProviderConfig is caught even if none of the
		// specific secret strings below happen to match.
		expect(JSON.parse(text)).toStrictEqual({
			google: false,
			github: false,
			emailAndPassword: true,
			oidc: { providerId: "oidc", name: "Pocket ID" },
		});

		// SECONDARY: defense in depth on the raw serialized text, independent of
		// the parsed-shape assertion above, in case of a nonstandard
		// serialization path that the shape check would not catch.
		expect(text).not.toContain(clientSecret);
		expect(text).not.toContain(clientId);
		expect(text).not.toContain(discoveryUrl);
	});

	it("is reachable without a session and honours the existing CORS policy", async () => {
		const allowedOrigin = "http://localhost:4321";

		const allowedResponse = await apiRequest("/v1/auth/providers", {
			headers: { origin: allowedOrigin },
		});
		expect(allowedResponse.status).toBe(200);
		expect(allowedResponse.headers.get("access-control-allow-origin")).toBe(allowedOrigin);

		const deniedResponse = await apiRequest("/v1/auth/providers", {
			headers: { origin: "https://evil.example" },
		});
		expect(deniedResponse.status).toBe(200);
		expect(deniedResponse.headers.get("access-control-allow-origin")).toBeNull();
	});
});

async function setUpFakeIdp(): Promise<FakeIdp> {
	// Each test mints its own issuer (embedding a fresh UUID) so the fixture
	// discovery URL is unique per case, per this repo's non-isolated D1/test
	// storage: a shared identifier across tests would let one pass for the
	// wrong reason. Fetch is mocked, matching oidc.test.ts, so genericOAuth's
	// eager discovery fetch resolves against this in-process fake rather than
	// attempting real network I/O against an unreachable host.
	const idp = await createFakeIdp(`https://${crypto.randomUUID()}.idp.test`);
	installFakeIdpFetch(idp, {
		discoveryUrl: idp.discoveryUrl,
		jwksUrl: idp.jwksUrl,
		tokenUrl: idp.tokenUrl,
	});
	return idp;
}
