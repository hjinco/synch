export const OIDC_PROVIDER_ID = "oidc";

const DEFAULT_SCOPES = ["openid", "profile", "email"] as const;
const DEFAULT_DISPLAY_NAME = "Single sign-on";

export type OidcProviderConfig = {
	providerId: typeof OIDC_PROVIDER_ID;
	displayName: string;
	discoveryUrl: string;
	clientId: string;
	clientSecret: string;
	accountIssuer: string;
	scopes: string[];
};

export type OidcEnvInput = {
	discoveryUrl?: string;
	clientId?: string;
	clientSecret?: string;
	displayName?: string;
	scopes?: string;
	accountIssuer?: string;
};

export class MissingOidcVariablesError extends Error {
	readonly missing: string[];

	constructor(missing: string[]) {
		super(`Missing OIDC variables: ${missing.join(", ")}`);
		this.name = "MissingOidcVariablesError";
		this.missing = missing;
	}
}

function presentValue(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

export function parseOidcProviderConfig(
	input: OidcEnvInput,
): OidcProviderConfig | undefined {
	const discoveryUrl = presentValue(input.discoveryUrl);
	const clientId = presentValue(input.clientId);
	const clientSecret = presentValue(input.clientSecret);

	const presentCount = [discoveryUrl, clientId, clientSecret].filter(
		(value) => value !== undefined,
	).length;

	if (presentCount === 0) {
		return undefined;
	}

	if (!discoveryUrl || !clientId || !clientSecret) {
		const missing: string[] = [];
		if (!discoveryUrl) {
			missing.push("OIDC_DISCOVERY_URL");
		}
		if (!clientId) {
			missing.push("OIDC_CLIENT_ID");
		}
		if (!clientSecret) {
			missing.push("OIDC_CLIENT_SECRET");
		}
		throw new MissingOidcVariablesError(missing);
	}

	const parsedDiscoveryUrl = new URL(discoveryUrl);

	// Derived from the configured discovery URL's origin rather than from a
	// fetched discovery document, because its whole purpose is to be available
	// when discovery is not: it scopes the stored account identity, so reading
	// it from a document we may be unable to fetch would defeat the point.
	const accountIssuer =
		presentValue(input.accountIssuer) ?? parsedDiscoveryUrl.origin;

	const scopes = presentValue(input.scopes)
		?.split(",")
		.map((scope) => scope.trim()) ?? [...DEFAULT_SCOPES];

	return {
		providerId: OIDC_PROVIDER_ID,
		displayName: presentValue(input.displayName) ?? DEFAULT_DISPLAY_NAME,
		discoveryUrl,
		clientId,
		clientSecret,
		accountIssuer,
		scopes,
	};
}
