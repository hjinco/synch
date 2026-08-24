import type {
	BlobGcScheduler,
	BlobGcStore,
	MaintenanceScheduler,
} from "../../ports/outbound";

export class BlobGcSchedulingService implements BlobGcScheduler {
	constructor(
		private readonly blobGcStore: BlobGcStore,
		private readonly maintenanceScheduler: MaintenanceScheduler,
	) {}

	async scheduleAt(dueAt: number, now = Date.now()): Promise<void> {
		await this.maintenanceScheduler.defer("blob_gc", dueAt, now);
	}

	async scheduleNext(now = Date.now()): Promise<number | null> {
		const nextGcAt = this.blobGcStore.nextGcAt(now);
		if (nextGcAt !== null) {
			await this.scheduleAt(nextGcAt, now);
		}
		return nextGcAt;
	}

	async scheduleNow(now = Date.now()): Promise<void> {
		await this.scheduleAt(now, now);
	}
}
