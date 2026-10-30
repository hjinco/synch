import { describe, expect, it } from "vitest";

import {
	isAllowlistExemptSource,
	isEmailAllowed,
	parseAllowedEmails,
} from "./allowed-emails";
import { OIDC_PROVIDER_ID } from "./oidc";

describe("allowed sign-up emails", () => {
	it("leaves sign-up unrestricted when the setting is absent or blank", () => {
		expect(parseAllowedEmails(undefined)).toBeUndefined();
		expect(parseAllowedEmails("  ")).toBeUndefined();
	});

	it("parses comma-separated addresses case-insensitively", () => {
		const allowed = parseAllowedEmails(" Alice@Example.com, bob@example.com ,, ");

		expect(allowed).toEqual(new Set(["alice@example.com", "bob@example.com"]));
		expect(isEmailAllowed(" ALICE@example.COM ", allowed!)).toBe(true);
		expect(isEmailAllowed("unknown@example.com", allowed!)).toBe(false);
	});
});

describe("isAllowlistExemptSource", () => {
	it("exempts an oauth sign-up from the configured OIDC provider", () => {
		// The identity provider is the authority for identities it asserts, so a
		// sign-up federated through the configured OIDC provider bypasses the
		// email allowlist.
		expect(
			isAllowlistExemptSource({
				method: "oauth",
				oauth: { providerId: OIDC_PROVIDER_ID },
			}),
		).toBe(true);
	});

	it("gates an email-password sign-up", () => {
		expect(isAllowlistExemptSource({ method: "email-password" })).toBe(false);
	});

	// This predicate MUST be an allow-list, not a deny-list. Better Auth's
	// ValidateUserInfoMethod union already includes magic-link, email-otp,
	// anonymous, siwe, phone-number, admin, and an open string type, so a
	// deny-list keyed on `method !== "email-password"` would silently exempt
	// every one of these -- and any future plugin -- from the allowlist with
	// zero code change. The allowlist is the only gate on password sign-up, so
	// a bypass there matters. A failure here is a regression to investigate,
	// not a test to update.
	it.each([
		["magic-link"],
		["email-otp"],
		["anonymous"],
		["admin"],
		["a-totally-new-made-up-method"],
	])("FAIL-CLOSED: gates an unrecognized source method (%s)", (method) => {
		expect(isAllowlistExemptSource({ method })).toBe(false);
	});

	// The exemption is scoped to the one configured OIDC provider, not to OAuth
	// sign-ups in general. A failure here is a regression to investigate, not a
	// test to update.
	it.each([["github"], ["google"]])(
		"FAIL-CLOSED: gates an oauth sign-up from a different provider id (%s)",
		(providerId) => {
			expect(
				isAllowlistExemptSource({ method: "oauth", oauth: { providerId } }),
			).toBe(false);
		},
	);

	// Absence of a provider id must never be treated as a match -- otherwise a
	// future refactor that leaves `oauth.providerId` unset would silently
	// bypass the allowlist. A failure here is a regression to investigate, not
	// a test to update.
	it("FAIL-CLOSED: gates an oauth sign-up with a missing provider id", () => {
		expect(isAllowlistExemptSource({ method: "oauth" })).toBe(false);
	});

	it("FAIL-CLOSED: gates an oauth sign-up with an undefined provider id", () => {
		expect(
			isAllowlistExemptSource({ method: "oauth", oauth: {} }),
		).toBe(false);
	});
});
