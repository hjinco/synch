import { createApp } from "../app";
import { createAuth, type AuthConfig } from "../auth/factory";
import { createPolarAuthPlugin, type PolarClientConfig } from "../billing/polar";
import { BillingRepository } from "../billing/repository";
import { BillingService } from "../billing/service";
import {
	capabilitiesFor,
	isCommunityEdition,
	type DeploymentProfile,
} from "../config/deployment-profile";
import type { AppDb } from "../db/client";
import { SubscriptionPolicyService } from "../subscription/policy-service";
import type { SubscriptionProductIdsByPlanId } from "../subscription/policy";
import { SyncService } from "../sync/access/service";
import { SyncTokenService } from "../sync/access/token-service";
import type { BlobStorage } from "../sync/blob/storage";
import {
	CoordinatorProxyRepository,
	type CoordinatorNamespace,
} from "../sync/coordinator/proxy-repository";
import { VaultPurgeConsumer } from "../vault/purge-consumer";
import type { VaultPurgeQueue } from "../vault/purge-queue";
import { VaultRepository } from "../vault/repository";
import { VaultService } from "../vault/service";

export type ApiApplicationDependencies = {
	db: AppDb;
	blobStorage: BlobStorage;
	coordinatorNamespace: CoordinatorNamespace;
	createVaultPurgeQueue(consumer: VaultPurgeConsumer): VaultPurgeQueue;
};

export type ApiApplicationConfig = {
	profile: DeploymentProfile;
	corsOrigin: string;
	auth: Omit<AuthConfig, "emailVerification" | "plugins">;
	syncTokenSecret: string;
	syncTokenTtlSeconds?: number;
	productIdsByPlanId: SubscriptionProductIdsByPlanId;
	billing?: PolarClientConfig & {
		publicBaseUrl: string;
		wwwBaseUrl: string;
		onSubscriptionUpsert?: (organizationId: string) => Promise<void>;
	};
};

/**
 * Builds the platform-neutral API service graph. Runtime entrypoints only
 * provide storage, coordinator and background-job adapters plus validated
 * configuration; repository and service wiring stays identical everywhere.
 */
export function createApiApplication(
	deps: ApiApplicationDependencies,
	config: ApiApplicationConfig,
) {
	const capabilities = capabilitiesFor(config.profile);
	const vaultRepository = new VaultRepository(deps.db);
	const coordinatorProxyRepository = new CoordinatorProxyRepository(
		deps.coordinatorNamespace,
	);
	const subscriptionPolicyService = new SubscriptionPolicyService(
		isCommunityEdition(config.profile),
		deps.db,
		{
			productIdsByPlanId: config.productIdsByPlanId,
		},
	);
	const billingFeature = createBillingFeature(deps.db, config, capabilities.billing);
	const auth = createAuth(deps.db, {
		...config.auth,
		emailVerification: capabilities.emailVerification,
		plugins: billingFeature.authPlugin ? [billingFeature.authPlugin] : [],
	});
	const syncTokenService = new SyncTokenService(config.syncTokenSecret);
	const purgeVaultService = new VaultService(
		vaultRepository,
		subscriptionPolicyService,
	);
	const vaultPurgeQueue = deps.createVaultPurgeQueue(
		new VaultPurgeConsumer(purgeVaultService, coordinatorProxyRepository),
	);
	const vaultService = new VaultService(
		vaultRepository,
		subscriptionPolicyService,
		vaultPurgeQueue,
	);
	const syncService = new SyncService(
		vaultService,
		syncTokenService,
		config.syncTokenTtlSeconds,
		coordinatorProxyRepository,
	);

	return {
		app: createApp(
			{
				auth,
				syncService,
				vaultService,
				syncTokenService,
				blobRepository: deps.blobStorage,
				coordinatorProxyRepository,
				subscriptionPolicyService,
				billingService: billingFeature.service,
			},
			{
				corsOrigin: config.corsOrigin,
			},
		),
		syncTokenService,
	};
}

function createBillingFeature(
	db: AppDb,
	config: ApiApplicationConfig,
	capability: "polar" | "disabled",
): {
	authPlugin: ReturnType<typeof createPolarAuthPlugin>;
	service?: BillingService;
} {
	if (capability === "disabled") {
		return { authPlugin: null };
	}
	if (!config.billing) {
		throw new Error("billing configuration is required for the managed edition");
	}

	const repository = new BillingRepository(db);
	return {
		authPlugin: createPolarAuthPlugin(config.billing, repository, {
			onSubscriptionUpsert: config.billing.onSubscriptionUpsert,
		}),
		service: new BillingService(repository, {
			...config.billing,
			productIdsByPlanId: config.productIdsByPlanId,
		}),
	};
}
