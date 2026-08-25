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
import { MaintenanceService } from "../sync-coordinator/application/services/maintenance-service";
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
import { bindCoordinatorApi } from "../sync-coordinator/application/services/bind-coordinator-api";
import { BlobService } from "../sync-coordinator/application/services/blob-service";
import { BlobGcService } from "../sync-coordinator/application/services/blob-gc-service";
import { EntryService } from "../sync-coordinator/application/services/entry-service";
import { HealthService } from "../sync-coordinator/application/services/health-service";
import { MutationService } from "../sync-coordinator/application/services/mutation-service";
import { CoordinatorControlMessageHandler } from "../sync-coordinator/adapters/inbound/websocket/control-message-handler";
import { SocketConnectionService } from "../sync-coordinator/application/services/socket-connection-service";
import { CoordinatorBlobStore } from "../sync-coordinator/adapters/outbound/sqlite/blob-store";
import { CoordinatorBlobGcStore } from "../sync-coordinator/adapters/outbound/sqlite/blob-gc-store";
import { CoordinatorStaleStagedBlobStore } from "../sync-coordinator/adapters/outbound/sqlite/stale-staged-blob-store";
import { CoordinatorCursorStore } from "../sync-coordinator/adapters/outbound/sqlite/cursor-store";
import { CoordinatorEntryStore } from "../sync-coordinator/adapters/outbound/sqlite/entry-store";
import {
	CoordinatorHealthStore,
	type CoordinatorSocketCounter,
} from "../sync-coordinator/adapters/outbound/sqlite/health-store";
import { CoordinatorHistoryStore } from "../sync-coordinator/adapters/outbound/sqlite/history-store";
import { CoordinatorMutationStore } from "../sync-coordinator/adapters/outbound/sqlite/mutation-store";
import type { CoordinatorStorageHandle } from "../sync-coordinator/adapters/outbound/sqlite/storage-handle";
import { VaultService } from "../sync-coordinator/application/services/vault-service";
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
	const blobGcStore = new CoordinatorBlobGcStore(deps.storageHandle);
	const staleStagedBlobStore = new CoordinatorStaleStagedBlobStore(deps.storageHandle);
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
	const healthService = new HealthService(
		healthStore,
		syncStatusRepository,
		cursorActiveTtlMs,
		deps.maintenanceScheduler,
		deps.socketGateway,
	);
	const blobGcService = new BlobGcService(
		cursorStore,
		blobGcStore,
		deps.blobStorage,
		objectKeyBuilder,
		healthStore,
		deps.maintenanceScheduler,
		healthService,
	);
	const blobService = new BlobService(
		syncTokenService,
		blobStore,
		blobGcService,
		deps.socketGateway,
		deps.blobStorage,
		objectKeyBuilder,
		blobGracePeriodMs,
		healthService,
	);
	const mutationService = new MutationService(
		mutationStore,
		blobGcService,
		cursorStore,
		deps.blobStorage,
		objectKeyBuilder,
		blobGracePeriodMs,
		healthService,
	);
	const entryService = new EntryService(
		entryStore,
		historyStore,
		cursorStore,
		mutationService,
		blobGcService,
	);
	const vaultService = new VaultService(
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
		healthService,
		staleStagedBlobStore,
		blobGcService,
	);
	const socketConnectionService = new SocketConnectionService(
		syncTokenService,
		vaultService,
		healthService,
	);
	const maintenanceService = new MaintenanceService(
		deps.maintenanceScheduler,
		blobGcService,
		healthService,
		vaultService,
	);
	const useCases = bindCoordinatorApi({
		blobService,
		blobGcService,
		entryService,
		healthService,
		maintenanceService,
		mutationService,
		socketConnectionService,
		vaultService,
	});
	const socketMessageHandler = new CoordinatorControlMessageHandler(
		deps.socketGateway,
		cursorStore,
		healthStore,
		useCases,
		healthService,
	);

	return {
		app: createCoordinatorApp({
			useCases,
			socketHandshake: deps.socketGateway,
		}),
		useCases,
		socketMessageHandler,
		socketConnectionService,
		dispose: () => healthService.dispose(),
	};
}
