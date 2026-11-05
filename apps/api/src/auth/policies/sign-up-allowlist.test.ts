import { describe, expect, it } from "vitest";

import { capabilitiesFor } from "../../config/deployment-profile";
import { requiresSignUpAllowlist } from "./sign-up-allowlist";

describe("requiresSignUpAllowlist", () => {
	it("requires the allowlist for community edition with password auth enabled", () => {
		const capabilities = capabilitiesFor({ platform: "cloudflare", edition: "community" });

		expect(requiresSignUpAllowlist(capabilities, "enabled")).toBe(true);
	});

	it("does not require the allowlist once password auth is disabled", () => {
		const capabilities = capabilitiesFor({ platform: "cloudflare", edition: "community" });

		expect(requiresSignUpAllowlist(capabilities, "disabled")).toBe(false);
	});

	it.each(["enabled", "disabled"] as const)(
		"never requires the allowlist for managed edition when password auth is %s",
		(emailAndPassword) => {
			const capabilities = capabilitiesFor({ platform: "cloudflare", edition: "managed" });

			expect(requiresSignUpAllowlist(capabilities, emailAndPassword)).toBe(false);
		},
	);
});
