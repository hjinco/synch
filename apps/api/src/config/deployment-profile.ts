export type RuntimePlatform = "cloudflare" | "node";
export type ProductEdition = "managed" | "community";

export type DeploymentProfile =
	| { platform: "cloudflare"; edition: ProductEdition }
	| { platform: "node"; edition: "community" };

export type ProductCapabilities = {
	billing: "polar" | "disabled";
	emailVerification: "required" | "disabled";
	signUpAccess: "open" | "allowlist";
	backgroundJobs: "cloudflare-queue" | "inline";
};

export const NODE_COMMUNITY_PROFILE = {
	platform: "node",
	edition: "community",
} as const satisfies DeploymentProfile;

export function createCloudflareProfile(selfHosted: boolean): DeploymentProfile {
	return {
		platform: "cloudflare",
		edition: selfHosted ? "community" : "managed",
	};
}

export function capabilitiesFor(profile: DeploymentProfile): ProductCapabilities {
	if (profile.edition === "managed") {
		return {
			billing: "polar",
			emailVerification: "required",
			signUpAccess: "open",
			backgroundJobs: "cloudflare-queue",
		};
	}

	return {
		billing: "disabled",
		emailVerification: "disabled",
		signUpAccess: "allowlist",
		backgroundJobs: "inline",
	};
}

export function isCommunityEdition(profile: DeploymentProfile): boolean {
	return profile.edition === "community";
}
