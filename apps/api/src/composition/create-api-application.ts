import { DrizzleSharingStore } from "../sharing/adapters/drizzle-sharing-store";
import { SharingService } from "../sharing/application/service";
import { SharingAccess } from "../sharing/application/access";
import { createApp } from "../app";
import type { AuthFeatureConfig } from "../auth/better-auth";
import type { BillingApplicationConfig } from "../billing/application";
import {
	capabilitiesFor,
	isCommunityEdition,
	type DeploymentProfile,
} from "../config/deployment-profile";
import { createSubscriptionFeature } from "./features/create-subscription-feature";
import { createAuthFeature } from "./features/create-auth-feature";
import { createVaultFeature } from "./features/create-vault-feature";
import { createBillingFeature } from "./features/create-billing-feature";
import { createSyncAccessFeature } from "./features/create-sync-access-feature";
import { createSyncBlobTransferFeature } from "./features/create-sync-blob-transfer-feature";
import type { AppDb } from "../db/client";
import type { SubscriptionProductIdsByPlanId } from "../subscription/application";
import {
	CoordinatorProxyRepository,
	type CoordinatorNamespace,
} from "../sync-coordinator/adapters/outbound/durable-object-rpc/coordinator-proxy-repository";
import type { BlobObjectStorage } from "../sync-blob-transfer/application/ports/outbound/blob-object-storage";
import {
	blobObjectKey,
	blobObjectKeyPrefix,
} from "../platform/blob/object-key";
import type { VaultPurgeMessage } from "../vault/application";

export type ApiApplicationDependencies = {
	db: AppDb;
	blobStorage: BlobObjectStorage;
	coordinatorNamespace: CoordinatorNamespace;
	vaultPurgeQueue?: Queue<VaultPurgeMessage>;
};

export type ApiApplicationConfig = {
	profile: DeploymentProfile;
	corsOrigin: string;
	auth: Omit<AuthFeatureConfig, "emailVerification">;
	syncTokenSecret: string;
	adminToken?: string;
	syncTokenTtlSeconds?: number;
	productIdsByPlanId: SubscriptionProductIdsByPlanId;
	billing?: Omit<BillingApplicationConfig, "productIdsByPlanId">;
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
	const coordinatorProxyRepository = new CoordinatorProxyRepository(
		deps.coordinatorNamespace,
	);
	const subscriptionFeature = createSubscriptionFeature(deps.db, {
		selfHosted: isCommunityEdition(config.profile),
		productIdsByPlanId: config.productIdsByPlanId,
	});
	const vaultFeature = createVaultFeature({
		db: deps.db,
		policyReader: subscriptionFeature.policyReader,
		coordinatorPurgeTransport: coordinatorProxyRepository,
		vaultPurgeQueue: deps.vaultPurgeQueue,
	});
	const billingFeature = createBillingFeature({
		db: deps.db,
		enabled: capabilities.billing === "polar",
		billing: config.billing
			? { ...config.billing, productIdsByPlanId: config.productIdsByPlanId }
			: undefined,
		productIdsByPlanId: config.productIdsByPlanId,
		subscriptionAccessReader: subscriptionFeature.accessReader,
	});
	const authFeature = createAuthFeature(
		deps.db,
		{
			...config.auth,
			emailVerification: capabilities.emailVerification,
		},
		billingFeature.authPlugin ? [billingFeature.authPlugin] : [],
	);
	const sharingStore = new DrizzleSharingStore(deps.db);
	const sharingAccess = new SharingAccess(
		sharingStore,
		subscriptionFeature.policyReader,
	);
	const sharing = new SharingService(
		sharingStore,
		subscriptionFeature.policyReader,
		coordinatorProxyRepository,
		{
			...config.auth,
			billingBaseURL: config.billing?.wwwBaseUrl,
			requireVerifiedEmail:
				capabilities.emailVerification === "required" && !config.auth.devMode,
		},
	);
	const syncAccessFeature = createSyncAccessFeature({
		vaultService: vaultFeature.service,
		accessReader: (userId, vaultId) => sharingAccess.require(userId, vaultId),
		accessVerifier: async (claims, token) =>
			coordinatorProxyRepository.authorizeSync(claims.vaultId, token, claims),
		coordinatorNamespace: deps.coordinatorNamespace,
		syncTokenSecret: config.syncTokenSecret,
		syncTokenTtlSeconds: config.syncTokenTtlSeconds,
	});
	const syncBlobTransferFeature = createSyncBlobTransferFeature({
		objectStorage: deps.blobStorage,
		coordinatorNamespace: deps.coordinatorNamespace,
		tokenVerifier: syncAccessFeature.tokenVerifier,
		objectKeyBuilder: { blobObjectKey, blobObjectKeyPrefix },
	});
	return {
		flushSharingRefreshes: () => sharing.flushRefreshes(),
		app: createApp(
			{
				sharing,
				authHttpHandler: authFeature.authHttpHandler,
				sessionReader: authFeature.sessionReader,
				syncTokenIssuer: syncAccessFeature.tokenIssuer,
				syncTokenRequestVerifier: syncAccessFeature.requestTokenVerifier,
				uploadBlob: syncBlobTransferFeature.uploadBlob,
				downloadBlob: syncBlobTransferFeature.downloadBlob,
				vaultService: vaultFeature.service,
				coordinatorProxyRepository,
				subscriptionPolicyService: subscriptionFeature.policyReader,
				billingService: billingFeature.service,
			},
			{
				corsOrigin: config.corsOrigin,
				authBaseUrl: config.auth.baseURL,
				adminToken: config.adminToken,
			},
		),
		syncTokenVerifier: syncAccessFeature.tokenVerifier,
	};
}
