import {
	decideBlobCollection,
	decidePendingDelete,
	earliestGcDeadline,
} from "../../domain/blob-gc-policy";
import type {
	BlobGcCandidate,
	BlobGcStore,
	BlobObjectKeyBuilder,
	BlobObjectRepository,
	HealthStateStore,
	MaintenanceScheduler,
	VaultStateStore,
} from "../ports/outbound";
import type { HealthService } from "./health-service";

/** Matches R2/S3 bulk-delete limits so one GC tick is one object-store round trip. */
export const GC_BATCH_SIZE = 1000;

export class BlobObjectBatchDeleteError extends Error {
	readonly name = "BlobObjectBatchDeleteError";

	constructor(
		readonly failedKeys: readonly string[],
		readonly deletedCount: number,
	) {
		super("blob_object_batch_delete_failed");
	}
}

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
		const nextGcAt = this.readNextGcAt(now);
		if (nextGcAt !== null) {
			await this.scheduleAt(nextGcAt, now);
		}
		return nextGcAt;
	}

	readNextGcAt(now = Date.now()): number | null {
		return earliestGcDeadline(this.blobGcStore.readGcDeadlines(now), now);
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
		const collectible = due.filter((blob) => this.isCollectible(blob, now));
		let deletedCount = 0;
		try {
			deletedCount = await this.deleteCollectibleBatch(
				effectiveVaultId,
				collectible,
				now,
			);
		} catch (error) {
			if (
				error instanceof BlobObjectBatchDeleteError &&
				error.deletedCount > 0
			) {
				this.healthService.notifyStorageStatusChanged();
			}
			throw error;
		}

		const nextGcAt = this.readNextGcAt(now);
		if ((options.scheduleNextGc ?? true) && nextGcAt !== null) {
			await this.scheduleAt(nextGcAt, now);
		}
		this.healthStore.recordGcCompleted(now);
		if (options.scheduleHealthFlush ?? true) {
			await this.maintenanceScheduler.defer("health_summary_flush", now, now);
		}
		if (deletedCount > 0) {
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
		const collectibleBlobs: BlobGcCandidate[] = [];
		for (const blobId of uniqueBlobIds) {
			this.blobGcStore.withPendingDeleteTransaction(
				blobId,
				now,
				(transaction) => {
					const facts = transaction.readFacts();
					if (!facts) {
						return;
					}

					const decision = decidePendingDelete(facts, now);
					if (decision.kind === "mark_pending_delete") {
						transaction.markPendingDelete(decision.deleteAfter);
					}
				},
			);
			const blob = this.blobGcStore.readCollectibleBlob(blobId, now);
			if (!blob || !this.isCollectible(blob, now)) {
				continue;
			}
			collectibleBlobs.push(blob);
		}

		let deletedCount = 0;
		try {
			deletedCount = await this.deleteCollectibleBatch(vaultId, collectibleBlobs, now);
		} catch (error) {
			if (error instanceof BlobObjectBatchDeleteError) {
				deletedCount = error.deletedCount;
			}
			console.error("[sync-coordinator] immediate purged blob deletion failed", {
				vaultId,
				blobIds: collectibleBlobs.map((blob) => blob.blob_id),
				error: error instanceof Error ? error.message : String(error),
			});
		}

		await this.scheduleNext(now);
		await this.healthService.scheduleSummaryFlush(now);
		if (deletedCount > 0) {
			this.healthService.notifyStorageStatusChanged();
		}
	}

	private async deleteCollectibleBatch(
		vaultId: string,
		blobs: readonly BlobGcCandidate[],
		now: number,
	): Promise<number> {
		if (blobs.length === 0) {
			return 0;
		}

		const { failedKeys } = await this.blobStorage.deleteMany(
			blobs.map((blob) =>
				this.objectKeyBuilder.blobObjectKey(vaultId, blob.blob_id),
			),
		);
		const failedKeySet = new Set(failedKeys);
		const succeededBlobIds = blobs
			.filter(
				(blob) =>
					!failedKeySet.has(
						this.objectKeyBuilder.blobObjectKey(vaultId, blob.blob_id),
					),
			)
			.map((blob) => blob.blob_id);
		const deletedCount =
			succeededBlobIds.length === 0
				? 0
				: this.blobGcStore.deleteCollectibleBlobs(succeededBlobIds, now).length;
		if (failedKeys.length > 0) {
			throw new BlobObjectBatchDeleteError(failedKeys, deletedCount);
		}
		return deletedCount;
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
