import type Database from "better-sqlite3";

import { apiError } from "../errors";
import type { AppDb } from "../db/client";
import { SubscriptionPolicyService } from "../subscription/policy-service";
import { SyncTokenService } from "../sync/access/token-service";
import type { BlobStorage } from "../sync/blob/storage";
import { CoordinatorMaintenanceService } from "../sync/coordinator/maintenance-service";
import { NodeMaintenanceScheduler } from "../sync/coordinator/node-maintenance-scheduler";
import { createCoordinatorApp } from "../sync/coordinator/routes";
import { CoordinatorService } from "../sync/coordinator/service";
import { BlobSyncService } from "../sync/coordinator/blob/sync-service";
import { EntryHistoryService } from "../sync/coordinator/entry/history-service";
import { EntrySyncService } from "../sync/coordinator/entry/sync-service";
import { HealthSyncService } from "../sync/coordinator/health/sync-service";
import { MutationCommitService } from "../sync/coordinator/mutation/commit-service";
import { CoordinatorControlMessageHandler } from "../sync/coordinator/socket/control-message-handler";
import { CoordinatorSocketConnectionService } from "../sync/coordinator/socket/connection-service";
import { NodeSocketGateway } from "../sync/coordinator/socket/node-service";
import { CoordinatorBlobStore } from "../sync/coordinator/store/blob-store";
import { CoordinatorCursorStore } from "../sync/coordinator/store/cursor-store";
import { CoordinatorEntryStore } from "../sync/coordinator/store/entry-store";
import { CoordinatorHealthStore } from "../sync/coordinator/store/health-store";
import { CoordinatorHistoryStore } from "../sync/coordinator/store/history-store";
import { CoordinatorMutationStore } from "../sync/coordinator/store/mutation-store";
import { SqliteCoordinatorStorageHandle } from "../sync/coordinator/store/sqlite-storage-handle";
import { SqliteCoordinatorStorage } from "../sync/coordinator/store/sqlite-storage-lifecycle";
import { VaultLockRegistry } from "../sync/coordinator/store/vault-lock";
import { VaultLifecycleService } from "../sync/coordinator/vault/lifecycle-service";
import { VaultSyncStatusRepository } from "../sync/health/status-repository";
import { VaultRepository } from "../vault/repository";

const ALARM_FAILURE_RETRY_MS = 30 * 1000;

export interface NodeCoordinatorSharedDeps {
	db: AppDb;
	blobStorage: BlobStorage;
	syncTokenSecret: string;
	selfHosted: boolean;
	polarProductIdsByPlanId: Record<string, string>;
}

/**
 * Per-vault coordinator, one SQLite file per vault (mirroring one Durable
 * Object per vault). This is the Node analogue of `createCoordinatorRuntime`
 * in `runtime/coordinator.ts`: same service wiring, swapped for the
 * self-hosted backends built in earlier stages (SqliteCoordinatorStorage,
 * NodeSocketGateway, NodeMaintenanceScheduler) in place of the DO-only ones.
 *
 * A Durable Object also serializes every request to a given instance via
 * input gates - two concurrent requests for the same vault never interleave
 * their storage access. A Node process has no such guarantee, so every
 * public entry point into this runtime (HTTP requests, socket messages, and
 * the socket connect/close lifecycle) is funneled through `vaultLock` to
 * reproduce that serialization. See `VaultLockRegistry` for why this is
 * necessary and what it doesn't cover (cross-process races, handled instead
 * by the process-level exclusive SQLite lock).
 */
export function createNodeCoordinatorRuntime(
	vaultId: string,
	sqlite: Database.Database,
	deps: NodeCoordinatorSharedDeps,
) {
	const vaultLock = new VaultLockRegistry();
	const blobGracePeriodMs = 30 * 60 * 1000;
	const cursorActiveTtlMs = 30 * 24 * 60 * 60 * 1000;

	const storage = new SqliteCoordinatorStorage(sqlite);
	const storageHandle = new SqliteCoordinatorStorageHandle(sqlite);
	const blobStore = new CoordinatorBlobStore(storageHandle);
	const cursorStore = new CoordinatorCursorStore(storageHandle);
	const entryStore = new CoordinatorEntryStore(storageHandle);
	const socketService = new NodeSocketGateway();
	const healthStore = new CoordinatorHealthStore(storageHandle, {
		count: () => socketService.socketCount(),
	});
	const historyStore = new CoordinatorHistoryStore(storageHandle);
	const mutationStore = new CoordinatorMutationStore(storageHandle);
	const vaultRepository = new VaultRepository(deps.db);
	const subscriptionPolicyService = new SubscriptionPolicyService(deps.selfHosted, deps.db, {
		productIdsByPlanId: deps.polarProductIdsByPlanId,
	});
	const syncStatusRepository = new VaultSyncStatusRepository(deps.db);
	const syncTokenService = new SyncTokenService(deps.syncTokenSecret);

	// `handleAlarm` isn't available until `application` is constructed below,
	// but the scheduler needs a callback now - same forward-reference-via-
	// closure pattern the coordinator's own test helpers use for the DO path.
	let application: CoordinatorService;
	const maintenanceScheduler = new NodeMaintenanceScheduler(storageHandle, async () => {
		try {
			await vaultLock.run(vaultId, () => application.handleAlarm());
		} catch (error) {
			// Mirrors `SyncCoordinator.alarm()`'s catch: an unhandled rejection
			// here would crash the whole Node process (unlike a DO, where a
			// failed alarm invocation only affects that one object).
			console.error("[node-coordinator] maintenance alarm failed", formatLogError(error));
			maintenanceScheduler.retryAfter(ALARM_FAILURE_RETRY_MS);
		}
	});

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
		deps.blobStorage,
		blobGracePeriodMs,
		maintenanceScheduler,
		healthSyncService,
	);
	const mutationCommitService = new MutationCommitService(
		mutationStore,
		blobStore,
		cursorStore,
		deps.blobStorage,
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
		deps.blobStorage,
		{
			readInitialVaultLimits: async (vaultId) => {
				const organizationId = await vaultRepository.readVaultOrganizationId(vaultId);
				if (!organizationId) {
					throw apiError(404, "not_found", "vault not found");
				}

				const policy = await subscriptionPolicyService.readOrganizationPolicy(organizationId);
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
	application = new CoordinatorService({
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

	const ready = (async () => {
		await storage.migrate();
		maintenanceScheduler.ensureArmed();
	})();

	const rawApp = createCoordinatorApp({ useCases: application });

	return {
		app: {
			fetch: (request: Request) => vaultLock.run(vaultId, () => rawApp.fetch(request)),
		},
		useCases: {
			handleSocketClose: () => vaultLock.run(vaultId, () => application.handleSocketClose()),
		},
		socketMessageHandler: {
			handle: (ws: WebSocket, message: string | ArrayBuffer) =>
				vaultLock.run(vaultId, () => socketMessageHandler.handle(ws, message)),
		},
		socketConnectionService: {
			prepareSocketSession: (request: Request, id: string) =>
				vaultLock.run(vaultId, () => socketConnectionService.prepareSocketSession(request, id)),
			completeSocketOpen: () => vaultLock.run(vaultId, () => socketConnectionService.completeSocketOpen()),
		},
		socketGateway: socketService,
		ready,
		close: () => {
			maintenanceScheduler.dispose();
			sqlite.close();
		},
	};
}

export type NodeCoordinatorRuntime = ReturnType<typeof createNodeCoordinatorRuntime>;

function formatLogError(error: unknown): Record<string, unknown> {
	if (error instanceof Error) {
		return { name: error.name, message: error.message, stack: error.stack, cause: error.cause };
	}
	return { message: String(error) };
}
