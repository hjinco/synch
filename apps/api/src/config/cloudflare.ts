import { recordOidcDiagnostic, shouldEmitOidcDiagnostic } from "../auth/oidc-diagnostics";
import {
	MissingOidcVariablesError,
	parseOidcProviderConfig,
	type OidcProviderConfig,
} from "../auth/policies/oidc";
import { requiresSignUpAllowlist } from "../auth/policies/sign-up-allowlist";
import type { SubscriptionPolicyRefreshMessage } from "../subscription/application";
import type {
	VaultPurgeMessage,
	VaultRetentionEmailMessage,
} from "../vault/application";
import {
	capabilitiesFor,
	createCloudflareProfile,
	type DeploymentProfile,
	type ProductCapabilities,
} from "./deployment-profile";
import { resolveOriginBinding, resolveUrlBinding } from "./env";

export type CloudflareRuntimeEnv = Omit<
	Env,
	| "AUTH_ALLOWED_EMAILS"
	| "AUTH_EMAIL_FROM"
	| "DEV_MODE"
	| "EMAIL"
	| "POLICY_REFRESH_QUEUE"
	| "VAULT_PURGE_QUEUE"
	| "RETENTION_NOTIFICATION_QUEUE"
	| "ADMIN_TOKEN"
> & {
	AUTH_ALLOWED_EMAILS?: string;
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	GITHUB_CLIENT_ID?: string;
	GITHUB_CLIENT_SECRET?: string;
	EMAIL?: SendEmail;
	AUTH_EMAIL_FROM?: string;
	DEV_MODE?: boolean | string;
	WWW_BASE_URL?: string;
	POLAR_ACCESS_TOKEN?: string;
	POLAR_WEBHOOK_SECRET?: string;
	POLAR_PLUS_MONTHLY_PRODUCT_ID?: string;
	POLAR_PLUS_ANNUAL_PRODUCT_ID?: string;
	POLAR_STARTER_MONTHLY_PRODUCT_ID?: string;
	POLAR_STARTER_ANNUAL_PRODUCT_ID?: string;
	POLAR_SANDBOX?: string;
	POLICY_REFRESH_QUEUE?: Queue<SubscriptionPolicyRefreshMessage>;
	VAULT_PURGE_QUEUE?: Queue<VaultPurgeMessage>;
	RETENTION_NOTIFICATION_QUEUE?: Queue<VaultRetentionEmailMessage>;
	ADMIN_TOKEN?: string;
	OIDC_DISCOVERY_URL?: string;
	OIDC_CLIENT_ID?: string;
	OIDC_CLIENT_SECRET?: string;
	OIDC_PROVIDER_NAME?: string;
	OIDC_SCOPES?: string;
	OIDC_ACCOUNT_ISSUER?: string;
	AUTH_EMAIL_PASSWORD?: string;
};

export type CloudflareHttpConfig = {
	profile: DeploymentProfile;
	capabilities: ProductCapabilities;
	authBaseUrl: string;
	publicOrigin: string;
	corsOrigin: string;
	devMode: boolean;
	polarSandbox: boolean;
	emailAndPassword: "enabled" | "disabled";
	oidc?: OidcProviderConfig;
};

export function parseCloudflareHttpConfig(
	env: CloudflareRuntimeEnv,
	request: Request,
): CloudflareHttpConfig {
	const profile = readCloudflareProfile(env);
	const capabilities = capabilitiesFor(profile);
	const requestOrigin = new URL(request.url).origin;
	const authBaseUrl = resolveUrlBinding("BETTER_AUTH_URL", env.BETTER_AUTH_URL, requestOrigin);
	const publicOrigin = new URL(authBaseUrl).origin;
	const devMode = parseBooleanBinding("DEV_MODE", env.DEV_MODE, false);
	const corsOrigin = devMode
		? "http://localhost:4321"
		: resolveOriginBinding("WWW_BASE_URL", env.WWW_BASE_URL, "http://localhost:4321");
	const emailAndPassword = parseEmailAndPasswordBinding(env.AUTH_EMAIL_PASSWORD);

	// createRuntimeApp rebuilds this config from bindings on every request instead
	// of once at process boot, so unlike Node (which validates at startup and exits
	// non-zero on a bad value) a bad binding here is not caught before traffic is
	// served. It throws mid-request, before createApp has registered /health, so
	// every route -- including /health -- returns a generic 500 until the binding
	// is fixed. There is no boot-time signal to catch this on Workers; operators
	// must check request logs (e.g. wrangler tail) to see the real cause. Because
	// this rebuild happens on every request, a persistent partial-config mistake
	// would otherwise mean one diagnostic per request for as long as it goes
	// unfixed; the de-duplicated diagnostic bounds that to one entry per outage
	// while the throw itself (and the resulting 500) still happens every time, so
	// the operator sees the missing variable names without the log volume.
	const oidc = parseOidcProviderConfigWithDiagnostic({
		discoveryUrl: env.OIDC_DISCOVERY_URL,
		clientId: env.OIDC_CLIENT_ID,
		clientSecret: env.OIDC_CLIENT_SECRET,
		displayName: env.OIDC_PROVIDER_NAME,
		scopes: env.OIDC_SCOPES,
		accountIssuer: env.OIDC_ACCOUNT_ISSUER,
	});

	if (
		requiresSignUpAllowlist(capabilities, emailAndPassword) &&
		!env.AUTH_ALLOWED_EMAILS?.trim()
	) {
		throw new Error(
			"AUTH_ALLOWED_EMAILS is required when password sign-up requires an allowlist",
		);
	}

	return {
		profile,
		capabilities,
		authBaseUrl,
		publicOrigin,
		corsOrigin,
		devMode,
		polarSandbox: parseBooleanBinding("POLAR_SANDBOX", env.POLAR_SANDBOX, false),
		emailAndPassword,
		oidc,
	};
}

/**
 * Wraps `parseOidcProviderConfig` so a partial OIDC binding set is still
 * reported through the bounded diagnostic channel before propagating --
 * `MissingOidcVariablesError` itself is deliberately left to propagate
 * unchanged (see the call site) so the request still fails the same way it
 * always has.
 */
function parseOidcProviderConfigWithDiagnostic(
	input: Parameters<typeof parseOidcProviderConfig>[0],
): OidcProviderConfig | undefined {
	try {
		return parseOidcProviderConfig(input);
	} catch (error) {
		if (error instanceof MissingOidcVariablesError) {
			const key = `partial-oidc-config:${error.missing.join(",")}`;
			if (shouldEmitOidcDiagnostic(key)) {
				recordOidcDiagnostic(key, { missing: error.missing });
			}
		}
		throw error;
	}
}

function parseEmailAndPasswordBinding(value: string | undefined): "enabled" | "disabled" {
	if (value === undefined || value.trim() === "") {
		return "enabled";
	}
	if (value === "enabled" || value === "disabled") {
		return value;
	}

	throw new Error(`AUTH_EMAIL_PASSWORD must be "enabled" or "disabled"`);
}

export function readCloudflareProfile(
	env: Pick<CloudflareRuntimeEnv, "SELF_HOSTED">,
): DeploymentProfile {
	return createCloudflareProfile(
		parseBooleanBinding("SELF_HOSTED", env.SELF_HOSTED, false),
	);
}

export function parseBooleanBinding(
	name: string,
	value: boolean | string | undefined,
	fallback: boolean,
): boolean {
	if (typeof value === "boolean") {
		return value;
	}
	if (value === undefined || value.trim() === "") {
		return fallback;
	}
	if (value === "true" || value === "1") {
		return true;
	}
	if (value === "false" || value === "0") {
		return false;
	}

	throw new Error(`${name} must be a boolean`);
}
