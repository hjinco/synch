import { createApp } from "../app";
import { createAuth } from "../auth";
import { readPolarProductIdsByPlanId } from "../billing/product-ids";
import { BillingRepository } from "../billing/repository";
import { createPolarAuthPlugin } from "../billing/polar";
import { BillingService } from "../billing/service";
import {
	parseCloudflareHttpConfig,
	type CloudflareRuntimeEnv,
} from "../config/cloudflare";
import { isCommunityEdition } from "../config/deployment-profile";
import { createDb } from "../db/client";
import { CloudflareSubscriptionPolicyRefreshQueue } from "../subscription/policy-refresh-queue";
import { SubscriptionPolicyService } from "../subscription/policy-service";
import { SyncService } from "../sync/access/service";
import { SyncTokenService } from "../sync/access/token-service";
import { BlobRepository } from "../sync/blob/repository";
import { CoordinatorProxyRepository } from "../sync/coordinator/proxy-repository";
import { VaultPurgeConsumer } from "../vault/purge-consumer";
import { CloudflareVaultPurgeQueue, type VaultPurgeQueue } from "../vault/purge-queue";
import type { VaultPurgeMessage } from "../vault/purge-queue";
import { VaultRepository } from "../vault/repository";
import { VaultService } from "../vault/service";

export function createRuntimeApp(env: CloudflareRuntimeEnv, request: Request) {
	const config = parseCloudflareHttpConfig(env, request);
	const communityEdition = isCommunityEdition(config.profile);
	const db = createDb(env.DB);
	const billingRepository = new BillingRepository(db);
	const productIdsByPlanId = readPolarProductIdsByPlanId(env);
	const polarConfig = {
		accessToken: env.POLAR_ACCESS_TOKEN,
		webhookSecret: env.POLAR_WEBHOOK_SECRET,
		sandbox: config.polarSandbox,
		publicBaseUrl: config.authBaseUrl,
	};
	const vaultRepository = new VaultRepository(db);
	const coordinatorProxyRepository = new CoordinatorProxyRepository(env.SYNC_COORDINATOR);
	const subscriptionPolicyService = new SubscriptionPolicyService(communityEdition, db, {
		productIdsByPlanId,
	});
	const polarAuthPlugin = config.capabilities.billing === "disabled"
		? null
		: createPolarAuthPlugin(polarConfig, billingRepository, {
				onSubscriptionUpsert: async (organizationId) => {
					const subscriptionPolicyRefreshQueue =
						new CloudflareSubscriptionPolicyRefreshQueue(
							requireBinding(env.POLICY_REFRESH_QUEUE, "POLICY_REFRESH_QUEUE"),
						);
					await subscriptionPolicyRefreshQueue.enqueueOrganizationPolicyRefresh(
						organizationId,
					);
				},
			});
	const auth = createAuth(db, {
		baseURL: config.authBaseUrl,
		trustedOrigins: Array.from(new Set([config.publicOrigin, config.corsOrigin])),
		emailVerification: config.capabilities.emailVerification,
		devMode: config.devMode,
		email: env.EMAIL,
		emailFrom: env.AUTH_EMAIL_FROM,
		allowedEmails:
			config.capabilities.signUpAccess === "allowlist"
				? requireNonBlankStringBinding(env.AUTH_ALLOWED_EMAILS, "AUTH_ALLOWED_EMAILS")
				: undefined,
		plugins: polarAuthPlugin ? [polarAuthPlugin] : [],
	});
	const blobRepository = new BlobRepository(env.SYNC_BLOBS);
	const syncTokenService = new SyncTokenService(env.SYNC_TOKEN_SECRET);
	const billingService = new BillingService(billingRepository, {
		...polarConfig,
		productIdsByPlanId,
		wwwBaseUrl: config.corsOrigin,
	});
	const vaultPurgeQueue = createVaultPurgeQueue({
		backgroundJobs: config.capabilities.backgroundJobs,
		vaultRepository,
		subscriptionPolicyService,
		coordinatorProxyRepository,
		queue: env.VAULT_PURGE_QUEUE,
	});
	const vaultService = new VaultService(
		vaultRepository,
		subscriptionPolicyService,
		vaultPurgeQueue,
	);
	const syncService = new SyncService(
		vaultService,
		syncTokenService,
		env.SYNC_TOKEN_TTL_SECONDS,
		coordinatorProxyRepository,
	);

	const app = createApp(
		{
			auth,
			syncService,
			vaultService,
			syncTokenService,
			blobRepository,
			coordinatorProxyRepository,
			subscriptionPolicyService,
			billingService,
		},
		{
			publicOrigin: config.publicOrigin,
			corsOrigin: config.corsOrigin,
			billingEnabled: config.capabilities.billing === "polar",
		},
	);

	return {
		async fetch(request: Request): Promise<Response> {
			return await app.fetch(request);
		},
	};
}

function createVaultPurgeQueue(input: {
	backgroundJobs: "cloudflare-queue" | "inline";
	vaultRepository: VaultRepository;
	subscriptionPolicyService: SubscriptionPolicyService;
	coordinatorProxyRepository: CoordinatorProxyRepository;
	queue?: Queue<VaultPurgeMessage>;
}): VaultPurgeQueue {
	if (input.backgroundJobs === "cloudflare-queue") {
		return new CloudflareVaultPurgeQueue(
			requireBinding(input.queue, "VAULT_PURGE_QUEUE"),
		);
	}

	const purgeVaultService = new VaultService(
		input.vaultRepository,
		input.subscriptionPolicyService,
	);
	return new InlineVaultPurgeQueue(
		new VaultPurgeConsumer(
			purgeVaultService,
			input.coordinatorProxyRepository,
		),
	);
}

class InlineVaultPurgeQueue implements VaultPurgeQueue {
	constructor(private readonly vaultPurgeConsumer: VaultPurgeConsumer) {}

	async enqueueVaultPurge(vaultId: string): Promise<void> {
		await this.vaultPurgeConsumer.purgeVault(vaultId);
	}
}

function requireBinding<T>(binding: T | undefined, name: string): T {
	if (!binding) {
		throw new Error(`${name} binding is required`);
	}

	return binding;
}

function requireNonBlankStringBinding(binding: string | undefined, name: string): string {
	if (!binding?.trim()) {
		throw new Error(`${name} binding is required`);
	}

	return binding;
}
