import { describe, expect, it } from "vitest";

import {
	capabilitiesFor,
	createCloudflareProfile,
	NODE_COMMUNITY_PROFILE,
} from "./deployment-profile";

describe("deployment profiles", () => {
	it("gates managed-only capabilities to the managed edition", () => {
		expect(createCloudflareProfile(false)).toEqual({
			platform: "cloudflare",
			edition: "managed",
		});

		const managed = capabilitiesFor(createCloudflareProfile(false));
		const community = capabilitiesFor(createCloudflareProfile(true));

		// Community/self-hosted editions must never enable billing or open
		// sign-up; managed deployments must require email verification.
		expect(managed.billing).toBe("polar");
		expect(managed.emailVerification).toBe("required");
		expect(community.billing).toBe("disabled");
		expect(community.signUpAccess).toBe("allowlist");
	});

	it("keeps both community runtimes on the same product capabilities", () => {
		expect(capabilitiesFor(createCloudflareProfile(true))).toEqual(
			capabilitiesFor(NODE_COMMUNITY_PROFILE),
		);
	});
});
