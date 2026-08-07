import {
	isCommunityEdition,
	type DeploymentProfile,
} from "../config/deployment-profile";
import type { AppDb } from "../db/client";
import { apiError } from "../errors";
import type { SubscriptionProductIdsByPlanId } from "../subscription/policy";
import { SubscriptionPolicyService } from "../subscription/policy-service";
import { SyncTokenService } from "../sync/access/token-service";
import { CoordinatorMaintenanceService } from "../sync/coordinator/maintenance-service";
import type {
	MaintenanceRunner,
	MaintenanceScheduler,
} from "../sync/coordinator/maintenance-scheduler";
import type {
	BlobObjectRepository,
	CoordinatorStorageLifecycle,
	SocketGateway,
} from "../sync/coordinator/ports";
import { createCoordinatorApp } from "../sync/coordinator/routes";
import { CoordinatorService } from "../sync/coordinator/service";
import { BlobSyncService } from "../sync/coordinator/blob/sync-service";
import { EntryHistoryService } from "../sync/coordinator/entry/history-service";
import { EntrySyncService } from "../sync/coordinator/entry/sync-service";
import { HealthSyncService } from "../sync/coordinator/health/sync-service";
import { MutationCommitService } from "../sync/coordinator/mutation/commit-service";
import { CoordinatorControlMessageHandler } from "../sync/coordinator/socket/control-message-handler";
import { CoordinatorSocketConnectionService } from "../sync/coordinator/socket/connection-service";
import { CoordinatorBlobStore } from "../sync/coordinator/store/blob-store";
import { CoordinatorCursorStore } from "../sync/coordinator/store/cursor-store";
import { CoordinatorEntryStore } from "../sync/coordinator/store/entry-store";
import {
	CoordinatorHealthStore,
	type CoordinatorSocketCounter,
} from "../sync/coordinator/store/health-store";
import { CoordinatorHistoryStore } from "../sync/coordinator/store/history-store";
import { CoordinatorMutationStore } from "../sync/coordinator/store/mutation-store";
import type { CoordinatorStorageHandle } from "../sync/coordinator/store/storage-handle";
import { VaultLifecycleService } from "../sync/coordinator/vault/lifecycle-service";
import { VaultSyncStatusRepository } from "../sync/health/status-repository";
import { VaultRepository } from "../vault/repository";

export type CoordinatorApplicationDependencies = {
	db: AppDb;
	storage: CoordinatorStorageLifecycle;
	storageHandle: CoordinatorStorageHandle;
	blobStorage: BlobObjectRepository;
	socketGateway: SocketGateway;
	socketCounter: CoordinatorSocketCounter;
	maintenanceScheduler: MaintenanceScheduler & MaintenanceRunner;
};

export type CoordinatorApplicationConfig = {
	profile: DeploymentProfile;
	productIdsByPlanId: SubscriptionProductIdsByPlanId;
	syncTokenSecret: string;
	blobGracePeriodMs?: number;
	cursorActiveTtlMs?: number;
};

const DEFAULT_BLOB_GRACE_PERIOD_MS = 30 * 60 * 1000;
const DEFAULT_CURSOR_ACTIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Builds the coordinator's platform-neutral stores and service graph. */
export function createCoordinatorApplication(
	deps: CoordinatorApplicationDependencies,
	config: CoordinatorApplicationConfig,
) {
	const blobGracePeriodMs =
		config.blobGracePeriodMs ?? DEFAULT_BLOB_GRACE_PERIOD_MS;
	const cursorActiveTtlMs =
		config.cursorActiveTtlMs ?? DEFAULT_CURSOR_ACTIVE_TTL_MS;
	const blobStore = new CoordinatorBlobStore(deps.storageHandle);
	const cursorStore = new CoordinatorCursorStore(deps.storageHandle);
	const entryStore = new CoordinatorEntryStore(deps.storageHandle);
	const healthStore = new CoordinatorHealthStore(
		deps.storageHandle,
		deps.socketCounter,
	);
	const historyStore = new CoordinatorHistoryStore(deps.storageHandle);
	const mutationStore = new CoordinatorMutationStore(deps.storageHandle);
	const vaultRepository = new VaultRepository(deps.db);
	const subscriptionPolicyService = new SubscriptionPolicyService(
		isCommunityEdition(config.profile),
		deps.db,
		{ productIdsByPlanId: config.productIdsByPlanId },
	);
	const syncStatusRepository = new VaultSyncStatusRepository(deps.db);
	const syncTokenService = new SyncTokenService(config.syncTokenSecret);
	const healthSyncService = new HealthSyncService(
		healthStore,
		syncStatusRepository,
		cursorActiveTtlMs,
		deps.maintenanceScheduler,
	);
	const blobSyncService = new BlobSyncService(
		syncTokenService,
		blobStore,
		cursorStore,
		healthStore,
		deps.socketGateway,
		deps.blobStorage,
		blobGracePeriodMs,
		deps.maintenanceScheduler,
		healthSyncService,
	);
	const mutationCommitService = new MutationCommitService(
		mutationStore,
		blobStore,
		cursorStore,
		deps.blobStorage,
		blobGracePeriodMs,
		deps.maintenanceScheduler,
		healthSyncService,
	);
	const entrySyncService = new EntrySyncService(entryStore, cursorStore);
	const entryHistoryService = new EntryHistoryService(
		entryStore,
		historyStore,
		cursorStore,
		mutationCommitService,
		blobSyncService,
	);
	const vaultLifecycleService = new VaultLifecycleService(
		deps.storage,
		cursorStore,
		healthStore,
		deps.socketGateway,
		deps.blobStorage,
		{
			readInitialVaultLimits: async (vaultId) => {
				const organizationId =
					await vaultRepository.readVaultOrganizationId(vaultId);
				if (!organizationId) {
					throw apiError(404, "not_found", "vault not found");
				}

				const policy =
					await subscriptionPolicyService.readOrganizationPolicy(organizationId);
				return policy.limits;
			},
		},
		healthSyncService,
	);
	const socketConnectionService = new CoordinatorSocketConnectionService(
		deps.socketGateway,
		syncTokenService,
		vaultLifecycleService,
		healthSyncService,
	);
	const maintenanceService = new CoordinatorMaintenanceService(
		deps.maintenanceScheduler,
		blobSyncService,
		healthSyncService,
		vaultLifecycleService,
	);
	const useCases = new CoordinatorService({
		blobSyncService,
		entryHistoryService,
		entrySyncService,
		healthSyncService,
		maintenanceService,
		mutationCommitService,
		socketConnectionService,
		vaultLifecycleService,
	});
	const socketMessageHandler = new CoordinatorControlMessageHandler(
		deps.socketGateway,
		cursorStore,
		healthStore,
		useCases,
		healthSyncService,
	);

	return {
		app: createCoordinatorApp({ useCases }),
		useCases,
		socketMessageHandler,
		socketConnectionService,
		dispose: () => blobSyncService.dispose(),
	};
}
