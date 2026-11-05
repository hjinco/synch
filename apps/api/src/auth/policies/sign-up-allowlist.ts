import type { ProductCapabilities } from "../../config/deployment-profile";

// The allowlist is the only gate on password sign-up, and it cannot prove that
// whoever submits an address controls that inbox: community deployments disable
// email verification, so anyone who knows an allowlisted address can register
// it. It must therefore stay required whenever password auth is enabled, and may
// only be absent when AUTH_EMAIL_PASSWORD=disabled removes password sign-up
// entirely. Do not relax this as "redundant with OIDC" -- provider verification
// covers only the identities that provider asserts, and does nothing for a
// password sign-up.
export function requiresSignUpAllowlist(
	capabilities: ProductCapabilities,
	emailAndPassword: "enabled" | "disabled",
): boolean {
	return capabilities.signUpAccess === "allowlist" && emailAndPassword === "enabled";
}
