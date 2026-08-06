import { readPolarProductIdsByPlanId } from "../billing/product-ids";
import { createCoordinatorApplication } from "../composition/create-coordinator-application";
import { readCloudflareProfile } from "../config/cloudflare";
import { createDb } from "../db/client";
import { BlobRepository } from "../sync/blob/repository";
import { CoordinatorMaintenanceScheduler } from "../sync/coordinator/maintenance-scheduler";
import { CoordinatorSocketService } from "../sync/coordinator/socket/service";
import { DurableCoordinatorStorage } from "../sync/coordinator/storage-lifecycle";
import { DurableObjectCoordinatorStorageHandle } from "../sync/coordinator/store/storage-handle";

export function createCoordinatorRuntime(ctx: DurableObjectState, env: Env) {
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
			blobStorage: new BlobRepository(env.SYNC_BLOBS),
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
	const ready = ctx.blockConcurrencyWhile(async () => {
		await storage.migrate();
		await maintenanceScheduler.ensureArmed();
	});

	return {
		app: application.app,
		useCases: application.useCases,
		socketMessageHandler: application.socketMessageHandler,
		ready,
	};
}
