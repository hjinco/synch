import { describe, expect, it } from "vitest";

import { isEmailAllowed, parseAllowedEmails } from "./allowed-emails";

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
