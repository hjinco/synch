import { describe, expect, it } from "vitest";

import {
	capabilitiesFor,
	createCloudflareProfile,
	NODE_COMMUNITY_PROFILE,
} from "./deployment-profile";

describe("deployment profiles", () => {
	it("models managed Cloudflare capabilities explicitly", () => {
		const profile = createCloudflareProfile(false);

		expect(profile).toEqual({ platform: "cloudflare", edition: "managed" });
		expect(capabilitiesFor(profile)).toEqual({
			billing: "polar",
			emailVerification: "required",
			signUpAccess: "open",
			backgroundJobs: "cloudflare-queue",
		});
	});

	it("keeps both community runtimes on the same product capabilities", () => {
		expect(capabilitiesFor(createCloudflareProfile(true))).toEqual(
			capabilitiesFor(NODE_COMMUNITY_PROFILE),
		);
	});
});
