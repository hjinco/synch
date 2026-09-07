import { SyncCoordinatorApplicationError } from "../errors/coordinator-errors";
import { decideBlobStage } from "../../domain/blob-policy";
import { decidePendingDelete, isBlobPinned } from "../../domain/blob-gc-policy";
import { STAGED_BLOB_STALE_MS } from "../../domain/health-policy";
import type { CoordinatorStores } from "../ports/outbound/unit-of-work";
import type { BlobRow } from "../ports/outbound/storage-models";

/** Must run inside the transaction that removed these rows. */
export function accountForDeletedBlobs(
	state: Pick<CoordinatorStores["state"], "adjustStorageUsedBytes">,
	deleted: readonly BlobRow[],
): void {
	const bytes = deleted.reduce((total, blob) => total + blob.size_bytes, 0);
	if (bytes > 0) state.adjustStorageUsedBytes(-bytes);
}

export function stageBlobRecord(
	stores: Pick<CoordinatorStores, "blobs" | "blobReferences" | "state">,
	blobId: string,
	sizeBytes: number,
	now: number,
	deleteAfter: number,
) {
	const pause = stores.state.readSyncPause();
	if (pause) return { kind: "sync_paused", reason: pause.reason } as const;
	const blob = stores.blobs.readBlob(blobId);
	if (!stores.state.readVaultId()) {
		throw new SyncCoordinatorApplicationError("sync_state_uninitialized", {
			message: "vault sync state is not initialized",
		});
	}
	const limits = stores.state.readVaultLimits();
	const decision = decideBlobStage({
		blobId,
		sizeBytes,
		now,
		staleAfterMs: STAGED_BLOB_STALE_MS,
		existing: blob
			? {
					state: blob.state,
					sizeBytes: blob.size_bytes,
					createdAt: blob.created_at,
				}
			: null,
		isPinned: blob
			? isBlobPinned(stores.blobReferences.read(blobId, now))
			: false,
		storageUsedBytes: stores.state.readStorageUsedBytes(),
		storageLimitBytes: limits.storageLimitBytes,
		maxFileSizeBytes: limits.maxFileSizeBytes,
	});
	if (decision.kind === "sync_paused")
		stores.state.pauseSync(now, decision.reason);
	if (decision.kind === "staged") {
		stores.blobs.persistStage(blobId, { sizeBytes, now, deleteAfter });
		if (decision.storageDeltaBytes > 0)
			stores.state.adjustStorageUsedBytes(decision.storageDeltaBytes);
	}
	return decision;
}

export function deleteUnreferencedStagedBlob(
	stores: Pick<CoordinatorStores, "blobs" | "blobReferences" | "state">,
	blobId: string,
	now: number,
): "missing" | "referenced" | "deleted" {
	const blob = stores.blobs.readBlob(blobId);
	if (!blob) return "missing";
	if (
		blob.state !== "staged" ||
		isBlobPinned(stores.blobReferences.read(blobId, now))
	)
		return "referenced";
	const deleted = stores.blobs.deleteBlobRecord(blobId, "staged");
	accountForDeletedBlobs(stores.state, deleted);
	return deleted.length > 0 ? "deleted" : "missing";
}
export function markUnpinnedBlobPendingDelete(
	stores: Pick<CoordinatorStores, "blobs" | "blobReferences">,
	blobId: string,
	now: number,
): void {
	const blob = stores.blobs.readBlob(blobId);
	if (!blob) return;
	const decision = decidePendingDelete(
		{
			state: blob.state,
			deleteAfter: blob.delete_after,
			...stores.blobReferences.read(blobId, now),
		},
		now,
	);
	if (decision.kind === "mark_pending_delete")
		stores.blobs.updateState(blobId, "pending_delete", decision.deleteAfter);
}
export function deleteCollectibleBlobRecords(
	stores: Pick<CoordinatorStores, "blobs" | "state">,
	blobIds: readonly string[],
	now: number,
): BlobRow[] {
	const deleted = stores.blobs.deleteCollectibleBlobs(blobIds, now);
	accountForDeletedBlobs(stores.state, deleted);
	return deleted;
}
