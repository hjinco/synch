import type { MaintenanceRunner } from "./maintenance-scheduler";

export interface BlobMaintenanceUseCases {
	runGc(
		vaultId?: string,
		options?: {
			now?: number;
			scheduleHealthFlush?: boolean;
			scheduleNextGc?: boolean;
		},
	): Promise<number | null>;
}

export interface HealthMaintenanceUseCases {
	flushSummary(options?: {
		now?: number;
		throwOnError?: boolean;
	}): Promise<number | null>;
}

export interface VaultPurgeState {
	isPurged(): boolean;
}

export class CoordinatorMaintenanceService {
	constructor(
		private readonly scheduler: MaintenanceRunner,
		private readonly blobSyncService: BlobMaintenanceUseCases,
		private readonly healthSyncService: HealthMaintenanceUseCases,
		private readonly vaultLifecycleService: VaultPurgeState,
	) {}

	async handleAlarm(): Promise<void> {
		if (this.vaultLifecycleService.isPurged()) {
			return;
		}

		await this.scheduler.drain({
			blob_gc: async (now) =>
				await this.blobSyncService.runGc(undefined, {
					now,
					scheduleHealthFlush: true,
					scheduleNextGc: false,
				}),
			health_summary_flush: async (now) =>
				await this.healthSyncService.flushSummary({
					now,
					throwOnError: true,
				}),
		});
	}
}
