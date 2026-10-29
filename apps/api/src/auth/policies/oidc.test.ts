import { describe, expect, it } from "vitest";

import {
	MissingOidcVariablesError,
	type OidcEnvInput,
	parseOidcProviderConfig,
} from "./oidc";

const fullInput: OidcEnvInput = {
	discoveryUrl: "https://idp.example.com/oidc",
	clientId: "test-client-id",
	clientSecret: "test-client-secret",
};

describe("OIDC provider config parsing", () => {
	it("returns a fully-defaulted config when all three OIDC variables are set", () => {
		expect(parseOidcProviderConfig(fullInput)).toEqual({
			providerId: "oidc",
			displayName: "Single sign-on",
			discoveryUrl: "https://idp.example.com/oidc",
			clientId: "test-client-id",
			clientSecret: "test-client-secret",
			accountIssuer: "https://idp.example.com",
			scopes: ["openid", "profile", "email"],
		});
	});

	it("returns undefined when no OIDC variables are set", () => {
		expect(parseOidcProviderConfig({})).toBeUndefined();
	});

	it.each([
		[
			"only discoveryUrl",
			{ discoveryUrl: fullInput.discoveryUrl },
			["OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"],
		],
		[
			"only clientId",
			{ clientId: fullInput.clientId },
			["OIDC_DISCOVERY_URL", "OIDC_CLIENT_SECRET"],
		],
		[
			"only clientSecret",
			{ clientSecret: fullInput.clientSecret },
			["OIDC_DISCOVERY_URL", "OIDC_CLIENT_ID"],
		],
		[
			"discoveryUrl and clientId",
			{ discoveryUrl: fullInput.discoveryUrl, clientId: fullInput.clientId },
			["OIDC_CLIENT_SECRET"],
		],
		[
			"discoveryUrl and clientSecret",
			{
				discoveryUrl: fullInput.discoveryUrl,
				clientSecret: fullInput.clientSecret,
			},
			["OIDC_CLIENT_ID"],
		],
		[
			"clientId and clientSecret",
			{ clientId: fullInput.clientId, clientSecret: fullInput.clientSecret },
			["OIDC_DISCOVERY_URL"],
		],
	])(
		"throws naming every missing variable when only %s is set",
		(_description, input, expectedMissing) => {
			let caught: unknown;
			try {
				parseOidcProviderConfig(input as OidcEnvInput);
			} catch (error) {
				caught = error;
			}

			expect(caught).toBeInstanceOf(MissingOidcVariablesError);
			expect((caught as MissingOidcVariablesError).missing).toEqual(
				expectedMissing,
			);
		},
	);

	it("treats whitespace-only values as absent", () => {
		expect(
			parseOidcProviderConfig({
				discoveryUrl: "   ",
				clientId: "   ",
				clientSecret: "   ",
			}),
		).toBeUndefined();
	});

	it("throws when the discovery URL is not a valid URL", () => {
		expect(() =>
			parseOidcProviderConfig({
				...fullInput,
				discoveryUrl: "not-a-url",
			}),
		).toThrow();
	});

	it("derives accountIssuer from the discovery URL's origin when not explicitly configured", () => {
		const result = parseOidcProviderConfig(fullInput);

		expect(result?.accountIssuer).toBe("https://idp.example.com");
	});
});
