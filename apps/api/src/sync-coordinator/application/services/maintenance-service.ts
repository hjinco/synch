import type { MaintenanceRunner } from "../ports/outbound";
import type { BlobGcService } from "./blob-gc-service";
import type { HealthService } from "./health-service";
import type { VaultService } from "./vault-service";

export class MaintenanceService {
	constructor(
		private readonly scheduler: MaintenanceRunner,
		private readonly blobGcService: Pick<BlobGcService, "runGc">,
		private readonly healthService: Pick<HealthService, "flushSummary">,
		private readonly vaultService: Pick<VaultService, "isPurged">,
	) {}

	async handleAlarm(): Promise<void> {
		if (this.vaultService.isPurged()) {
			return;
		}

		await this.scheduler.drain({
			blob_gc: async (now) =>
				await this.blobGcService.runGc(undefined, {
					now,
					scheduleHealthFlush: true,
					scheduleNextGc: false,
				}),
			health_summary_flush: async (now) =>
				await this.healthService.flushSummary({
					now,
					throwOnError: true,
				}),
		});
	}
}
