import { decideBlobCollection } from "../../../domain/blob-gc-policy";
import type {
	BlobGcScheduler,
	BlobGcStore,
	BlobObjectKeyBuilder,
	BlobObjectRepository,
	HealthStateStore,
	HealthSummaryScheduler,
	MaintenanceScheduler,
	PurgedBlobCollector,
	StorageStatusNotifier,
	VaultStateStore,
} from "../../ports/outbound";

const GC_BATCH_SIZE = 64;

export type RunBlobGcOptions = {
	now?: number;
	scheduleHealthFlush?: boolean;
	scheduleNextGc?: boolean;
};

/** Application service for all blob garbage-collection triggers. */
export class BlobGarbageCollectionService implements PurgedBlobCollector {
	constructor(
		private readonly vaultStateStore: Pick<VaultStateStore, "readVaultId">,
		private readonly blobGcStore: BlobGcStore,
		private readonly blobStorage: BlobObjectRepository,
		private readonly objectKeyBuilder: BlobObjectKeyBuilder,
		private readonly blobGcScheduler: BlobGcScheduler,
		private readonly healthStore: Pick<HealthStateStore, "recordGcCompleted">,
		private readonly maintenanceScheduler: MaintenanceScheduler,
		private readonly healthSummaryScheduler: HealthSummaryScheduler,
		private readonly storageStatusNotifier: StorageStatusNotifier,
	) {}

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
			await this.blobGcScheduler.scheduleAt(nextGcAt, now);
		}
		this.healthStore.recordGcCompleted(now);
		if (options.scheduleHealthFlush ?? true) {
			await this.maintenanceScheduler.defer("health_summary_flush", now, now);
		}
		if (due.length > 0) {
			this.storageStatusNotifier.notifyStorageStatusChanged();
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

		await this.blobGcScheduler.scheduleNext(now);
		await this.healthSummaryScheduler.scheduleSummaryFlush(now);
		if (deletedCount > 0) {
			this.storageStatusNotifier.notifyStorageStatusChanged();
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
