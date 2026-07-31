import { createApp } from "../app";
import { createAuth } from "../auth";
import { readPolarProductIdsByPlanId } from "../billing/product-ids";
import { BillingRepository } from "../billing/repository";
import { createPolarAuthPlugin } from "../billing/polar";
import { BillingService } from "../billing/service";
import { resolveOriginBinding, resolveUrlBinding } from "../config/env";
import { createDb } from "../db/client";
import { CloudflareSubscriptionPolicyRefreshQueue } from "../subscription/policy-refresh-queue";
import type { SubscriptionPolicyRefreshMessage } from "../subscription/policy-refresh-queue";
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

type RuntimeEnv = Omit<
	Env,
	"AUTH_EMAIL_FROM" | "DEV_MODE" | "EMAIL" | "POLICY_REFRESH_QUEUE" | "VAULT_PURGE_QUEUE"
> & {
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
};

export function createRuntimeApp(env: RuntimeEnv, request: Request) {
	const requestOrigin = new URL(request.url).origin;
	const authBaseUrl = resolveUrlBinding("BETTER_AUTH_URL", env.BETTER_AUTH_URL, requestOrigin);
	const publicOrigin = new URL(authBaseUrl).origin;
	const devMode = resolveBooleanBinding(env.DEV_MODE, false);
	const corsOrigin = devMode
		? "http://localhost:4321"
		: resolveOriginBinding("WWW_BASE_URL", env.WWW_BASE_URL, "http://localhost:4321");
	const db = createDb(env.DB);
	const billingRepository = new BillingRepository(db);
	const productIdsByPlanId = readPolarProductIdsByPlanId(env);
	const polarConfig = {
		accessToken: env.POLAR_ACCESS_TOKEN,
		webhookSecret: env.POLAR_WEBHOOK_SECRET,
		sandbox: resolveBooleanBinding(env.POLAR_SANDBOX, false),
		publicBaseUrl: authBaseUrl,
	};
	const vaultRepository = new VaultRepository(db);
	const coordinatorProxyRepository = new CoordinatorProxyRepository(env.SYNC_COORDINATOR);
	const subscriptionPolicyService = new SubscriptionPolicyService(env.SELF_HOSTED, db, {
		productIdsByPlanId,
	});
	const polarAuthPlugin = env.SELF_HOSTED
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
		baseURL: authBaseUrl,
		trustedOrigins: Array.from(new Set([publicOrigin, corsOrigin])),
		selfHosted: env.SELF_HOSTED,
		devMode,
		email: env.EMAIL,
		emailFrom: env.AUTH_EMAIL_FROM,
		plugins: polarAuthPlugin ? [polarAuthPlugin] : [],
	});
	const blobRepository = new BlobRepository(env.SYNC_BLOBS);
	const syncTokenService = new SyncTokenService(env.SYNC_TOKEN_SECRET);
	const billingService = new BillingService(billingRepository, {
		...polarConfig,
		productIdsByPlanId,
		wwwBaseUrl: corsOrigin,
	});
	const vaultPurgeQueue = createVaultPurgeQueue({
		selfHosted: env.SELF_HOSTED,
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
			publicOrigin,
			corsOrigin,
			billingEnabled: !env.SELF_HOSTED,
		},
	);

	return {
		async fetch(request: Request): Promise<Response> {
			return await app.fetch(request);
		},
	};
}

function resolveBooleanBinding(value: boolean | string | undefined, fallback: boolean): boolean {
	if (typeof value === "boolean") {
		return value;
	}
	if (value === undefined || value.trim() === "") {
		return fallback;
	}

	return value === "true" || value === "1";
}

function createVaultPurgeQueue(input: {
	selfHosted: boolean;
	vaultRepository: VaultRepository;
	subscriptionPolicyService: SubscriptionPolicyService;
	coordinatorProxyRepository: CoordinatorProxyRepository;
	queue?: Queue<VaultPurgeMessage>;
}): VaultPurgeQueue {
	if (!input.selfHosted) {
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
