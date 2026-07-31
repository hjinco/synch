import { apiError } from "../errors";
import { readPolarProductIdsByPlanId } from "../billing/product-ids";
import { createDb } from "../db/client";
import { SubscriptionPolicyService } from "../subscription/policy-service";
import { SyncTokenService } from "../sync/access/token-service";
import { BlobRepository } from "../sync/blob/repository";
import { CoordinatorMaintenanceScheduler } from "../sync/coordinator/maintenance-scheduler";
import { CoordinatorMaintenanceService } from "../sync/coordinator/maintenance-service";
import { createCoordinatorApp } from "../sync/coordinator/routes";
import { CoordinatorService } from "../sync/coordinator/service";
import { BlobSyncService } from "../sync/coordinator/blob/sync-service";
import { EntryHistoryService } from "../sync/coordinator/entry/history-service";
import { EntrySyncService } from "../sync/coordinator/entry/sync-service";
import { HealthSyncService } from "../sync/coordinator/health/sync-service";
import { MutationCommitService } from "../sync/coordinator/mutation/commit-service";
import { CoordinatorControlMessageHandler } from "../sync/coordinator/socket/control-message-handler";
import { CoordinatorSocketConnectionService } from "../sync/coordinator/socket/connection-service";
import { CoordinatorSocketService } from "../sync/coordinator/socket/service";
import { DurableCoordinatorStorage } from "../sync/coordinator/storage-lifecycle";
import { CoordinatorBlobStore } from "../sync/coordinator/store/blob-store";
import { CoordinatorCursorStore } from "../sync/coordinator/store/cursor-store";
import { CoordinatorEntryStore } from "../sync/coordinator/store/entry-store";
import { CoordinatorHealthStore } from "../sync/coordinator/store/health-store";
import { CoordinatorHistoryStore } from "../sync/coordinator/store/history-store";
import { CoordinatorMutationStore } from "../sync/coordinator/store/mutation-store";
import { DurableObjectCoordinatorStorageHandle } from "../sync/coordinator/store/storage-handle";
import { VaultLifecycleService } from "../sync/coordinator/vault/lifecycle-service";
import { VaultSyncStatusRepository } from "../sync/health/status-repository";
import { VaultRepository } from "../vault/repository";

export function createCoordinatorRuntime(ctx: DurableObjectState, env: Env) {
	const blobGracePeriodMs = 30 * 60 * 1000;
	const cursorActiveTtlMs = 30 * 24 * 60 * 60 * 1000;
	const db = createDb(env.DB);
	const storage = new DurableCoordinatorStorage(ctx);
	const storageHandle = new DurableObjectCoordinatorStorageHandle(ctx.storage);
	const blobStore = new CoordinatorBlobStore(storageHandle);
	const cursorStore = new CoordinatorCursorStore(storageHandle);
	const entryStore = new CoordinatorEntryStore(storageHandle);
	const healthStore = new CoordinatorHealthStore(storageHandle, {
		count: () => ctx.getWebSockets().length,
	});
	const historyStore = new CoordinatorHistoryStore(storageHandle);
	const mutationStore = new CoordinatorMutationStore(storageHandle);
	const socketService = new CoordinatorSocketService(ctx);
	const blobRepository = new BlobRepository(env.SYNC_BLOBS);
	const vaultRepository = new VaultRepository(db);
	const subscriptionPolicyService = new SubscriptionPolicyService(env.SELF_HOSTED, db, {
		productIdsByPlanId: readPolarProductIdsByPlanId(env),
	});
	const syncStatusRepository = new VaultSyncStatusRepository(db);
	const syncTokenService = new SyncTokenService(env.SYNC_TOKEN_SECRET);
	const maintenanceScheduler = new CoordinatorMaintenanceScheduler(ctx);
	const healthSyncService = new HealthSyncService(
		healthStore,
		syncStatusRepository,
		cursorActiveTtlMs,
		maintenanceScheduler,
	);
	const blobSyncService = new BlobSyncService(
		syncTokenService,
		blobStore,
		cursorStore,
		healthStore,
		socketService,
		blobRepository,
		blobGracePeriodMs,
		maintenanceScheduler,
		healthSyncService,
	);
	const mutationCommitService = new MutationCommitService(
		mutationStore,
		blobStore,
		cursorStore,
		blobRepository,
		blobGracePeriodMs,
		maintenanceScheduler,
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
		storage,
		cursorStore,
		healthStore,
		socketService,
		blobRepository,
		{
			readInitialVaultLimits: async (vaultId) => {
				const organizationId = await vaultRepository.readVaultOrganizationId(vaultId);
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
		socketService,
		syncTokenService,
		vaultLifecycleService,
		healthSyncService,
	);
	const maintenanceService = new CoordinatorMaintenanceService(
		maintenanceScheduler,
		blobSyncService,
		healthSyncService,
		vaultLifecycleService,
	);
	const application = new CoordinatorService({
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
		socketService,
		cursorStore,
		healthStore,
		application,
		healthSyncService,
	);
	const ready = ctx.blockConcurrencyWhile(async () => {
		await storage.migrate();
		await maintenanceScheduler.ensureArmed();
	});

	return {
		app: createCoordinatorApp({
			useCases: application,
		}),
		useCases: application,
		socketMessageHandler,
		ready,
	};
}
