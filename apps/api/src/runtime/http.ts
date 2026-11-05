import { readPolarProductIdsByPlanId } from "../billing/adapters/outbound/product-ids";
import { createApiApplication } from "../composition/create-api-application";
import {
	parseCloudflareHttpConfig,
	type CloudflareRuntimeEnv,
} from "../config/cloudflare";
import { createSubscriptionPolicyRefreshQueue } from "../composition/features/create-subscription-feature";
import { createDb } from "../db/client";
import { R2BlobObjectStorage } from "../sync-blob-transfer/adapters/outbound/r2-object-storage";
import type { SubscriptionPolicyRefreshMessage } from "../subscription/application";
import type { VaultPurgeMessage } from "../vault/application";

export function createRuntimeApp(env: CloudflareRuntimeEnv, request: Request) {
	const config = parseCloudflareHttpConfig(env, request);
	const productIdsByPlanId = readPolarProductIdsByPlanId(env);
	const application = createApiApplication(
		{
			db: createDb(env.DB),
			blobStorage: new R2BlobObjectStorage(env.SYNC_BLOBS),
			coordinatorNamespace: env.SYNC_COORDINATOR,
			vaultPurgeQueue:
				config.capabilities.backgroundJobs === "cloudflare-queue"
					? requireBinding<Queue<VaultPurgeMessage>>(
							env.VAULT_PURGE_QUEUE,
							"VAULT_PURGE_QUEUE",
						)
					: undefined,
		},
		{
			profile: config.profile,
			corsOrigin: config.corsOrigin,
			auth: {
				baseURL: config.authBaseUrl,
				trustedOrigins: Array.from(
					new Set([config.publicOrigin, config.corsOrigin]),
				),
				devMode: config.devMode,
				googleClientId: env.GOOGLE_CLIENT_ID,
				googleClientSecret: env.GOOGLE_CLIENT_SECRET,
				githubClientId: env.GITHUB_CLIENT_ID,
				githubClientSecret: env.GITHUB_CLIENT_SECRET,
				email: env.EMAIL,
				emailFrom: env.AUTH_EMAIL_FROM,
				// parseCloudflareHttpConfig already threw above (via
				// requiresSignUpAllowlist) if an allowlist is required and absent, so
				// this binding needs no second gate here -- duplicating that rule
				// would let the two copies drift, and previously did: this used to
				// require AUTH_ALLOWED_EMAILS whenever signUpAccess was "allowlist"
				// regardless of emailAndPassword, which made the config layer's
				// AUTH_EMAIL_PASSWORD=disabled path impossible to actually boot.
				allowedEmails: env.AUTH_ALLOWED_EMAILS,
				oidc: config.oidc,
				emailAndPassword: config.emailAndPassword,
			},
			syncTokenSecret: env.SYNC_TOKEN_SECRET,
			adminToken:
				config.profile.edition === "managed" ? env.ADMIN_TOKEN : undefined,
			syncTokenTtlSeconds: env.SYNC_TOKEN_TTL_SECONDS,
			productIdsByPlanId,
			billing: {
				accessToken: env.POLAR_ACCESS_TOKEN,
				webhookSecret: env.POLAR_WEBHOOK_SECRET,
				sandbox: config.polarSandbox,
				publicBaseUrl: config.authBaseUrl,
				wwwBaseUrl: config.corsOrigin,
				onSubscriptionUpsert: async (organizationId) => {
					const queue = createSubscriptionPolicyRefreshQueue(
						requireBinding<Queue<SubscriptionPolicyRefreshMessage>>(
							env.POLICY_REFRESH_QUEUE,
							"POLICY_REFRESH_QUEUE",
						),
					);
					await queue.enqueueOrganizationPolicyRefresh(organizationId);
				},
			},
		},
	);

	return {
		async fetch(request: Request): Promise<Response> {
			return await application.app.fetch(request);
		},
	};
}

function requireBinding<T>(binding: T | undefined, name: string): T {
	if (!binding) {
		throw new Error(`${name} binding is required`);
	}

	return binding;
}

