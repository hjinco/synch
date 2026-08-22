import {
	isCommunityEdition,
	type DeploymentProfile,
} from "../config/deployment-profile";
import { createSubscriptionFeature } from "./features/create-subscription-feature";
import { createVaultOrganizationReader } from "./features/create-vault-feature";
import { createSyncTokenFeature } from "./features/create-sync-access-feature";
import { blobObjectKey, blobObjectKeyPrefix } from "../platform/blob/object-key";
import type { AppDb } from "../db/client";
import type { SubscriptionProductIdsByPlanId } from "../subscription/application";
import { SyncCoordinatorApplicationError } from "../sync-coordinator/application/errors/coordinator-errors";
import { CoordinatorMaintenanceService } from "../sync-coordinator/application/use-cases/maintenance/maintenance-service";
import type {
	MaintenanceRunner,
	MaintenanceScheduler,
} from "../sync-coordinator/adapters/outbound/scheduler/maintenance-scheduler";
import type {
	BlobObjectRepository,
	CoordinatorStorageLifecycle,
	SocketGateway,
} from "../sync-coordinator/application/ports/outbound";
import { createCoordinatorApp } from "../sync-coordinator/adapters/inbound/http/routes";
import { CoordinatorService } from "../sync-coordinator/application/use-cases/coordinator-service";
import { BlobSyncService } from "../sync-coordinator/application/use-cases/blob/sync-service";
import { EntryHistoryService } from "../sync-coordinator/application/use-cases/entry/history-service";
import { EntrySyncService } from "../sync-coordinator/application/use-cases/entry/sync-service";
import { HealthSyncService } from "../sync-coordinator/application/use-cases/health/sync-service";
import { MutationCommitService } from "../sync-coordinator/application/use-cases/mutation/commit-service";
import { CoordinatorControlMessageHandler } from "../sync-coordinator/adapters/inbound/websocket/control-message-handler";
import { CoordinatorSocketConnectionService } from "../sync-coordinator/application/use-cases/socket/connection-service";
import { CoordinatorBlobStore } from "../sync-coordinator/adapters/outbound/sqlite/blob-store";
import { CoordinatorCursorStore } from "../sync-coordinator/adapters/outbound/sqlite/cursor-store";
import { CoordinatorEntryStore } from "../sync-coordinator/adapters/outbound/sqlite/entry-store";
import {
	CoordinatorHealthStore,
	type CoordinatorSocketCounter,
} from "../sync-coordinator/adapters/outbound/sqlite/health-store";
import { CoordinatorHistoryStore } from "../sync-coordinator/adapters/outbound/sqlite/history-store";
import { CoordinatorMutationStore } from "../sync-coordinator/adapters/outbound/sqlite/mutation-store";
import type { CoordinatorStorageHandle } from "../sync-coordinator/adapters/outbound/sqlite/storage-handle";
import { CoordinatorSyncRepairService } from "../sync-coordinator/application/use-cases/repair/repair-service";
import { VaultLifecycleService } from "../sync-coordinator/application/use-cases/vault/lifecycle-service";
import { VaultSyncStatusRepository } from "../sync-coordinator/adapters/outbound/health-persistence/status-repository";

export type CoordinatorApplicationDependencies = {
	db: AppDb;
	storage: CoordinatorStorageLifecycle;
	storageHandle: CoordinatorStorageHandle;
	blobStorage: BlobObjectRepository;
	socketGateway: SocketGateway & {
		openSocket(request: Request, session: import("../sync-coordinator/application/dto/types").SocketSession): Promise<Response>;
	};
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
	const subscriptionFeature = createSubscriptionFeature(deps.db, {
		selfHosted: isCommunityEdition(config.profile),
		productIdsByPlanId: config.productIdsByPlanId,
	});
	const vaultOrganizationReader = createVaultOrganizationReader(deps.db);
	const syncStatusRepository = new VaultSyncStatusRepository(deps.db);
	const syncTokenFeature = createSyncTokenFeature({
		syncTokenSecret: config.syncTokenSecret,
	});
	const syncTokenService = syncTokenFeature.tokenVerifier;
	const objectKeyBuilder = { blobObjectKey, blobObjectKeyPrefix };
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
		objectKeyBuilder,
		blobGracePeriodMs,
		deps.maintenanceScheduler,
		healthSyncService,
	);
	const mutationCommitService = new MutationCommitService(
		mutationStore,
		blobStore,
		cursorStore,
		deps.blobStorage,
		objectKeyBuilder,
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
		objectKeyBuilder,
		{
			readInitialVaultLimits: async (vaultId) => {
				const organizationId =
					await vaultOrganizationReader.readVaultOrganizationId(vaultId);
				if (!organizationId) {
					throw new SyncCoordinatorApplicationError("not_found", {
						message: "vault not found",
					});
				}

				const policy =
					await subscriptionFeature.policyReader.readOrganizationPolicy(organizationId);
				return policy.limits;
			},
		},
		healthSyncService,
	);
	const socketConnectionService = new CoordinatorSocketConnectionService(
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
	const syncRepairService = new CoordinatorSyncRepairService(
		blobStore,
		cursorStore,
		deps.blobStorage,
		objectKeyBuilder,
		deps.maintenanceScheduler,
	);
	const useCases = new CoordinatorService({
		blobSyncService,
		entryHistoryService,
		entrySyncService,
		healthSyncService,
		maintenanceService,
		mutationCommitService,
		socketConnectionService,
		syncRepairService,
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
		app: createCoordinatorApp({
			useCases,
			socketHandshake: deps.socketGateway,
		}),
		useCases,
		socketMessageHandler,
		socketConnectionService,
		dispose: () => blobSyncService.dispose(),
	};
}
