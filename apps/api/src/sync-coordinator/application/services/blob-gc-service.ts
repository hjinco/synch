import { decideBlobCollection } from "../../domain/blob-gc-policy";
import type {
	BlobGcStore,
	BlobObjectKeyBuilder,
	BlobObjectRepository,
	HealthStateStore,
	MaintenanceScheduler,
	VaultStateStore,
} from "../ports/outbound";
import type { HealthService } from "./health-service";

const GC_BATCH_SIZE = 64;

export type RunBlobGcOptions = {
	now?: number;
	scheduleHealthFlush?: boolean;
	scheduleNextGc?: boolean;
};

/** Application service for all blob garbage-collection triggers. */
export class BlobGcService {
	constructor(
		private readonly vaultStateStore: Pick<VaultStateStore, "readVaultId">,
		private readonly blobGcStore: BlobGcStore,
		private readonly blobStorage: BlobObjectRepository,
		private readonly objectKeyBuilder: BlobObjectKeyBuilder,
		private readonly healthStore: Pick<HealthStateStore, "recordGcCompleted">,
		private readonly maintenanceScheduler: MaintenanceScheduler,
		private readonly healthService: Pick<
			HealthService,
			"scheduleSummaryFlush" | "notifyStorageStatusChanged"
		>,
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

	async runGc(
		vaultId?: string,
		options: RunBlobGcOptions = {},
	): Promise<number | null> {
		const effectiveVaultId = vaultId ?? this.vaultStateStore.readVaultId();
		if (!effectiveVaultId) {
			return null;
		}

		const now = options.now ?? Date.now();
		this.blobGcStore.expireEntryVersions(now);
		const due = this.blobGcStore.listCollectibleBlobs(now, GC_BATCH_SIZE);
		for (const blob of due) {
			if (!this.isCollectible(blob, now)) {
				continue;
			}

			await this.blobStorage.delete(
				this.objectKeyBuilder.blobObjectKey(effectiveVaultId, blob.blob_id),
			);
			this.blobGcStore.deleteBlobIfCollectible(blob.blob_id, now);
		}

		const nextGcAt = this.blobGcStore.nextGcAt(now);
		if ((options.scheduleNextGc ?? true) && nextGcAt !== null) {
			await this.scheduleAt(nextGcAt, now);
		}
		this.healthStore.recordGcCompleted(now);
		if (options.scheduleHealthFlush ?? true) {
			await this.maintenanceScheduler.defer("health_summary_flush", now, now);
		}
		if (due.length > 0) {
			this.healthService.notifyStorageStatusChanged();
		}
		return nextGcAt;
	}

	async collectPurgedBlobs(
		vaultId: string,
		blobIds: readonly string[],
	): Promise<void> {
		const uniqueBlobIds = [...new Set(blobIds)];
		if (uniqueBlobIds.length === 0) {
			return;
		}

		const now = Date.now();
		this.blobGcStore.expireEntryVersions(now);
		let deletedCount = 0;
		for (const blobId of uniqueBlobIds) {
			this.blobGcStore.markBlobPendingDeleteIfUnpinned(blobId, now);
			const blob = this.blobGcStore.readCollectibleBlob(blobId, now);
			if (!blob || !this.isCollectible(blob, now)) {
				continue;
			}

			try {
				await this.blobStorage.delete(
					this.objectKeyBuilder.blobObjectKey(vaultId, blobId),
				);
				if (this.blobGcStore.deleteBlobIfCollectible(blobId, now) === "deleted") {
					deletedCount += 1;
				}
			} catch (error) {
				console.error("[sync-coordinator] immediate purged blob deletion failed", {
					vaultId,
					blobId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		await this.scheduleNext(now);
		await this.healthService.scheduleSummaryFlush(now);
		if (deletedCount > 0) {
			this.healthService.notifyStorageStatusChanged();
		}
	}

	private isCollectible(
		blob: {
			state: "staged" | "live" | "pending_delete";
			delete_after: number | null;
		},
		now: number,
	): boolean {
		return (
			decideBlobCollection(
				{
					state: blob.state,
					deleteAfter: blob.delete_after,
					hasCurrentReference: false,
					hasRetainedHistory: false,
				},
				now,
			).kind === "collectible"
		);
	}
}
