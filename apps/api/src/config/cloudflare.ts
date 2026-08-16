import type { SubscriptionPolicyRefreshMessage } from "../subscription/policy-refresh-queue";
import type { VaultPurgeMessage } from "../vault/purge-queue";
import type { VaultRetentionEmailMessage } from "../vault/retention-queue";
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
> & {
	AUTH_ALLOWED_EMAILS?: string;
	EMAIL?: SendEmail;
	AUTH_EMAIL_FROM?: string;
	DEV_MODE?: boolean | string;
	WWW_BASE_URL?: string;
	POLAR_ACCESS_TOKEN?: string;
	POLAR_WEBHOOK_SECRET?: string;
	POLAR_STARTER_MONTHLY_PRODUCT_ID?: string;
	POLAR_STARTER_ANNUAL_PRODUCT_ID?: string;
	POLAR_SANDBOX?: string;
	POLICY_REFRESH_QUEUE?: Queue<SubscriptionPolicyRefreshMessage>;
	VAULT_PURGE_QUEUE?: Queue<VaultPurgeMessage>;
	RETENTION_NOTIFICATION_QUEUE?: Queue<VaultRetentionEmailMessage>;
};

export type CloudflareHttpConfig = {
	profile: DeploymentProfile;
	capabilities: ProductCapabilities;
	authBaseUrl: string;
	publicOrigin: string;
	corsOrigin: string;
	devMode: boolean;
	polarSandbox: boolean;
};

export function parseCloudflareHttpConfig(
	env: CloudflareRuntimeEnv,
	request: Request,
): CloudflareHttpConfig {
	const profile = readCloudflareProfile(env);
	const requestOrigin = new URL(request.url).origin;
	const authBaseUrl = resolveUrlBinding("BETTER_AUTH_URL", env.BETTER_AUTH_URL, requestOrigin);
	const publicOrigin = new URL(authBaseUrl).origin;
	const devMode = parseBooleanBinding("DEV_MODE", env.DEV_MODE, false);
	const corsOrigin = devMode
		? "http://localhost:4321"
		: resolveOriginBinding("WWW_BASE_URL", env.WWW_BASE_URL, "http://localhost:4321");

	return {
		profile,
		capabilities: capabilitiesFor(profile),
		authBaseUrl,
		publicOrigin,
		corsOrigin,
		devMode,
		polarSandbox: parseBooleanBinding("POLAR_SANDBOX", env.POLAR_SANDBOX, false),
	};
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
