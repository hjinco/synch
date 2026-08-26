import { readPolarProductIdsByPlanId } from "../billing/adapters/outbound/product-ids";
import { createCoordinatorApplication } from "../composition/create-coordinator-application";
import {
	readCloudflareProfile,
	type CloudflareRuntimeEnv,
} from "../config/cloudflare";
import { createDb } from "../db/client";
import { R2BlobObjectStorage } from "../sync-blob-transfer/adapters/outbound/r2-object-storage";
import { CoordinatorMaintenanceScheduler } from "../sync-coordinator/adapters/outbound/scheduler/maintenance-scheduler";
import { CoordinatorSocketService } from "../sync-coordinator/adapters/outbound/socket/durable-object-service";
import { DurableCoordinatorStorage } from "../sync-coordinator/adapters/outbound/storage-lifecycle/durable-object-storage";
import { DurableObjectCoordinatorStorageHandle } from "../sync-coordinator/adapters/outbound/sqlite/storage-handle";

export function createCoordinatorRuntime(ctx: DurableObjectState, env: CloudflareRuntimeEnv) {
	const profile = readCloudflareProfile(env);
	const db = createDb(env.DB);
	const storage = new DurableCoordinatorStorage(ctx);
	const storageHandle = new DurableObjectCoordinatorStorageHandle(ctx.storage);
	const socketService = new CoordinatorSocketService(ctx);
	const maintenanceScheduler = new CoordinatorMaintenanceScheduler(ctx);
	const application = createCoordinatorApplication(
		{
			db,
			storage,
			storageHandle,
			blobStorage: new R2BlobObjectStorage(env.SYNC_BLOBS),
			socketGateway: socketService,
			socketCounter: { count: () => ctx.getWebSockets().length },
			maintenanceScheduler,
		},
		{
			profile,
			productIdsByPlanId: readPolarProductIdsByPlanId(env),
			syncTokenSecret: env.SYNC_TOKEN_SECRET,
		},
	);
	const ready = ctx.blockConcurrencyWhile(async (): Promise<void> => {
		await storage.migrate();
		await maintenanceScheduler.ensureArmed();
	});

	return {
		app: application.app,
		useCases: application.useCases,
		socketMessageHandler: application.socketMessageHandler,
		socketGateway: socketService,
		ready,
	};
}
