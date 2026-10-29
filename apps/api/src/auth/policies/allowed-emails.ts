import { OIDC_PROVIDER_ID } from "./oidc";

export const SIGN_UP_EMAIL_NOT_ALLOWED = {
	code: "SIGN_UP_EMAIL_NOT_ALLOWED",
	message: "This email address is not allowed to sign up.",
} as const;

/**
 * True only for sign-ups the configured OIDC provider vouches for.
 *
 * Deliberately an allow-list keyed on BOTH method and provider id. Anything
 * unrecognized -- a new Better Auth plugin, a second OAuth provider, a future
 * member of the open-ended source.method union -- stays gated by
 * AUTH_ALLOWED_EMAILS. Inverting this into a deny-list reintroduces a silent
 * bypass, since the allowlist is the only gate on password sign-up.
 */
export function isAllowlistExemptSource(source: {
	method: string;
	oauth?: { providerId?: string } | undefined;
}): boolean {
	return source.method === "oauth" && source.oauth?.providerId === OIDC_PROVIDER_ID;
}

function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

export function parseAllowedEmails(
	value: string | undefined,
): ReadonlySet<string> | undefined {
	if (!value?.trim()) {
		return undefined;
	}

	return new Set(value.split(",").map(normalizeEmail).filter(Boolean));
}

export function isEmailAllowed(
	email: string,
	allowedEmails: ReadonlySet<string>,
): boolean {
	return allowedEmails.has(normalizeEmail(email));
}
