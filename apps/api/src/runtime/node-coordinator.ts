import type Database from "better-sqlite3";

import { createCoordinatorApplication } from "../composition/create-coordinator-application";
import type { DeploymentProfile } from "../config/deployment-profile";
import type { AppDb } from "../db/client";
import type { SubscriptionProductIdsByPlanId } from "../subscription/application";
import type { BlobObjectStorage } from "../sync-blob-transfer/application/ports/outbound/blob-object-storage";
import { NodeMaintenanceScheduler } from "../sync-coordinator/adapters/outbound/scheduler/node-maintenance-scheduler";
import { NodeSocketGateway } from "../sync-coordinator/adapters/outbound/socket/node-service";
import { SqliteCoordinatorStorageHandle } from "../sync-coordinator/adapters/outbound/sqlite/storage-handle";
import { SqliteCoordinatorStorage } from "../sync-coordinator/adapters/outbound/sqlite/storage-lifecycle";
import { VaultLockRegistry } from "../sync-coordinator/adapters/outbound/sqlite/vault-lock";
import type { ClientControlMessage } from "../sync-coordinator/application/dto/protocol-types";

const ALARM_FAILURE_RETRY_MS = 30 * 1000;

export interface NodeCoordinatorSharedDeps {
	db: AppDb;
	blobStorage: BlobObjectStorage;
	syncTokenSecret: string;
	profile: Extract<DeploymentProfile, { platform: "node" }>;
	productIdsByPlanId: SubscriptionProductIdsByPlanId;
}

/**
 * Per-vault coordinator, one SQLite file per vault (mirroring one Durable
 * Object per vault). The shared `createCoordinatorApplication` owns the
 * service graph; this runtime supplies SqliteCoordinatorStorage,
 * NodeSocketGateway and NodeMaintenanceScheduler in place of DO adapters.
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
	const storage = new SqliteCoordinatorStorage(sqlite);
	const storageHandle = new SqliteCoordinatorStorageHandle(sqlite);
	const socketService = new NodeSocketGateway();

	// `handleAlarm` isn't available until `application` is constructed below,
	// but the scheduler needs a callback now - same forward-reference-via-
	// closure pattern the coordinator's own test helpers use for the DO path.
	let application: ReturnType<typeof createCoordinatorApplication>;
	const maintenanceScheduler = new NodeMaintenanceScheduler(storageHandle, async () => {
		try {
			await vaultLock.run(vaultId, () => application.useCases.handleAlarm());
		} catch (error) {
			// Mirrors `SyncCoordinator.alarm()`'s catch: an unhandled rejection
			// here would crash the whole Node process (unlike a DO, where a
			// failed alarm invocation only affects that one object).
			console.error("[node-coordinator] maintenance alarm failed", formatLogError(error));
			maintenanceScheduler.retryAfter(ALARM_FAILURE_RETRY_MS);
		}
	});
	application = createCoordinatorApplication(
		{
			db: deps.db,
			storage,
			storageHandle,
			blobStorage: deps.blobStorage,
			socketGateway: socketService,
			socketCounter: { count: () => socketService.socketCount() },
			maintenanceScheduler,
		},
		{
			profile: deps.profile,
			productIdsByPlanId: deps.productIdsByPlanId,
			syncTokenSecret: deps.syncTokenSecret,
		},
	);

	const ready = (async () => {
		await storage.migrate();
		maintenanceScheduler.ensureArmed();
	})();

	return {
		app: {
			fetch: (request: Request) =>
				vaultLock.run(vaultId, () => application.app.fetch(request)),
		},
		useCases: {
			handleSocketClose: () =>
				vaultLock.run(vaultId, () => application.useCases.handleSocketClose()),
		},
		socketMessageHandler: {
			handle: (connectionId: string, message: ClientControlMessage) =>
				vaultLock.run(vaultId, () =>
					application.socketMessageHandler.handle(connectionId, message),
				),
			handleDisconnect: (connectionId: string) =>
				vaultLock.run(vaultId, () => {
					application.socketMessageHandler.handleDisconnect(connectionId);
				}),
		},
		socketConnectionService: {
			prepareSocketSession: (token: string | null, id: string) =>
				vaultLock.run(vaultId, () =>
					application.socketConnectionService.prepareSocketSession(token, id),
				),
			completeSocketOpen: () =>
				vaultLock.run(vaultId, () =>
					application.socketConnectionService.completeSocketOpen(),
				),
		},
		socketGateway: socketService,
		ready,
		close: () => {
			application.dispose();
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
