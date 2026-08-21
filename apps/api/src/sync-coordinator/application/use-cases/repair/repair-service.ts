import type {
	BlobObjectRepository,
	BlobObjectKeyBuilder,
	BlobStateStore,
	SyncRepairResult,
	SyncPauseState,
	VaultStateStore,
} from "../../ports/outbound";
import type { MaintenanceScheduler } from "../../ports/outbound";
import { STAGED_BLOB_STALE_MS } from "../../../domain/health-policy";

const MAX_REPAIRABLE_STALE_STAGED_BLOBS = 100;
const STALE_BLOB_PAUSE_REASON_PREFIX = "staged blob ";

export class CoordinatorSyncRepairService {
	constructor(
		private readonly blobStore: BlobStateStore,
		private readonly vaultStateStore: Pick<
			VaultStateStore,
			"vaultStateExistsFor" | "readSyncPause" | "clearSyncPause"
		>,
		private readonly blobStorage: BlobObjectRepository,
		private readonly objectKeyBuilder: BlobObjectKeyBuilder,
		private readonly maintenanceScheduler: MaintenanceScheduler,
	) {}

	async repairSyncState(vaultId: string): Promise<SyncRepairResult> {
		if (!this.vaultStateStore.vaultStateExistsFor(vaultId)) {
			return emptyRepairResult(null, null, "not_paused");
		}

		const now = Date.now();
		const pause = this.vaultStateStore.readSyncPause();
		const staleBlobs = this.blobStore.listStaleStagedBlobs(
			now,
			STAGED_BLOB_STALE_MS,
			MAX_REPAIRABLE_STALE_STAGED_BLOBS + 1,
		);

		if (pause && !pause.reason.startsWith(STALE_BLOB_PAUSE_REASON_PREFIX)) {
			return repairRequiredResult(
				pause,
				staleBlobs.length,
				null,
				"unsupported_pause_reason",
			);
		}

		if (staleBlobs.length > MAX_REPAIRABLE_STALE_STAGED_BLOBS) {
			return repairRequiredResult(
				pause,
				staleBlobs.length,
				null,
				"repair_limit_exceeded",
			);
		}

		let deletedStagedBlobCount = 0;
		let issue: SyncRepairResult["issue"];
		for (const blob of staleBlobs) {
			// Drop the staged row first so a concurrent commit cannot mark the
			// blob live after its object has already been deleted. A leftover
			// object is recoverable; a live entry pointing at missing ciphertext
			// is not.
			const metadataResult = this.blobStore.deleteUnreferencedStagedBlob(
				blob.blob_id,
				now,
			);
			if (metadataResult === "referenced") {
				issue = "referenced_staged_blob";
				continue;
			}

			try {
				await this.blobStorage.delete(
					this.objectKeyBuilder.blobObjectKey(vaultId, blob.blob_id),
				);
			} catch (error) {
				console.error("[sync-repair] blob object deletion failed", {
					vaultId,
					blobId: blob.blob_id,
					error: error instanceof Error ? error.message : String(error),
				});
				issue = "blob_storage_delete_failed";
				continue;
			}

			if (metadataResult === "deleted") {
				deletedStagedBlobCount += 1;
			}
		}

		const remainingStaleBlobs = this.blobStore.listStaleStagedBlobs(
			now,
			STAGED_BLOB_STALE_MS,
			MAX_REPAIRABLE_STALE_STAGED_BLOBS + 1,
		);
		const nextGcAt = this.blobStore.nextBlobGcAt();

		// Re-arm the shared GC job after repair. The scheduler buckets this to
		// the next alarm boundary and the normal GC handler will remove the job
		// or compute the next real deadline.
		await this.maintenanceScheduler.defer("blob_gc", now, now);

		if (issue || remainingStaleBlobs.length > 0) {
			return repairRequiredResult(
				pause,
				remainingStaleBlobs.length,
				nextGcAt,
				issue ?? "referenced_staged_blob",
				deletedStagedBlobCount,
			);
		}

		if (pause) {
			this.vaultStateStore.clearSyncPause();
		}

		return {
			status: pause || deletedStagedBlobCount > 0 ? "repaired" : "not_paused",
			deletedStagedBlobCount,
			remainingStaleStagedBlobCount: 0,
			nextGcAt,
			pause: null,
		};
	}
}

function emptyRepairResult(
	pause: SyncPauseState | null,
	nextGcAt: number | null,
	status: SyncRepairResult["status"],
): SyncRepairResult {
	return {
		status,
		deletedStagedBlobCount: 0,
		remainingStaleStagedBlobCount: 0,
		nextGcAt,
		pause,
	};
}

function repairRequiredResult(
	pause: SyncPauseState | null,
	remainingStaleStagedBlobCount: number,
	nextGcAt: number | null,
	issue: NonNullable<SyncRepairResult["issue"]>,
	deletedStagedBlobCount = 0,
): SyncRepairResult {
	return {
		status: "manual_repair_required",
		deletedStagedBlobCount,
		remainingStaleStagedBlobCount,
		nextGcAt,
		pause,
		issue,
	};
}
