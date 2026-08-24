import { and, eq, sql } from "drizzle-orm";

import * as doSchema from "../../../../db/do";
import { SyncCoordinatorApplicationError } from "../../../application/errors/coordinator-errors";
import type {
	BlobStageFacts,
	BlobStageTransaction,
} from "../../../application/ports/outbound/blob-state-store";
import type { BlobRow, BlobState } from "../../../application/ports/outbound/storage-models";
import type { CoordinatorDb, CoordinatorStorageHandle } from "./storage-handle";

type BlobDb = Pick<CoordinatorDb, "delete" | "insert" | "select" | "update">;

export class CoordinatorBlobStore {
	constructor(private readonly handle: CoordinatorStorageHandle) {}

	withStageTransaction<T>(
		blobId: string,
		now: number,
		operation: (transaction: BlobStageTransaction) => T,
	): T {
		return this.handle.db.transaction((tx) => {
			const transaction: BlobStageTransaction = {
				readFacts: (): BlobStageFacts => {
					const storage = tx
						.select({
							usedBytes: doSchema.coordinatorState.storageUsedBytes,
							storageLimitBytes: doSchema.coordinatorState.storageLimitBytes,
							maxFileSizeBytes: doSchema.coordinatorState.maxFileSizeBytes,
						})
						.from(doSchema.coordinatorState)
						.where(eq(doSchema.coordinatorState.id, 1))
						.limit(1)
						.get();
					if (!storage) {
						throw new SyncCoordinatorApplicationError(
							"sync_state_uninitialized",
							{ message: "vault sync state is not initialized" },
						);
					}

					const existing = tx
						.select({
							state: doSchema.blobs.state,
							sizeBytes: doSchema.blobs.sizeBytes,
							createdAt: doSchema.blobs.createdAt,
						})
						.from(doSchema.blobs)
						.where(eq(doSchema.blobs.blobId, blobId))
						.limit(1)
						.get();

					return {
						existing: existing
							? {
									state: existing.state as BlobState,
									sizeBytes: Number(existing.sizeBytes),
									createdAt: Number(existing.createdAt),
									}
							: null,
						isPinned: existing ? this.isBlobPinned(blobId, false, now) : false,
						storageUsedBytes: Number(storage.usedBytes),
						storageLimitBytes: Number(storage.storageLimitBytes),
						maxFileSizeBytes: Number(storage.maxFileSizeBytes),
					};
				},
				persistStage: ({ sizeBytes, now: stagedAt, deleteAfter, storageDeltaBytes }) => {
					if (storageDeltaBytes > 0) {
						tx.update(doSchema.coordinatorState)
							.set({
								storageUsedBytes: sql`${doSchema.coordinatorState.storageUsedBytes} + ${storageDeltaBytes}`,
							})
							.where(eq(doSchema.coordinatorState.id, 1))
							.run();
					}
					tx.insert(doSchema.blobs)
						.values({
							blobId,
							state: "staged",
							sizeBytes,
							createdAt: stagedAt,
							lastUploadedAt: stagedAt,
							deleteAfter,
						})
						.onConflictDoUpdate({
							target: doSchema.blobs.blobId,
							set: {
								state: "staged",
								lastUploadedAt: stagedAt,
								deleteAfter,
							},
						})
						.run();
				},
				pauseSync: (pausedAt, reason) => {
					tx.update(doSchema.coordinatorState)
						.set({
							syncPausedAt: sql`coalesce(${doSchema.coordinatorState.syncPausedAt}, ${pausedAt})`,
							syncPauseReason: sql`coalesce(${doSchema.coordinatorState.syncPauseReason}, ${reason})`,
						})
						.where(eq(doSchema.coordinatorState.id, 1))
						.run();
				},
			};

			return operation(transaction);
		});
	}

	readBlob(blobId: string): BlobRow | null {
		const row = this.handle.db
			.select({
				blob_id: doSchema.blobs.blobId,
				state: doSchema.blobs.state,
				size_bytes: doSchema.blobs.sizeBytes,
				created_at: doSchema.blobs.createdAt,
				last_uploaded_at: doSchema.blobs.lastUploadedAt,
				delete_after: doSchema.blobs.deleteAfter,
			})
			.from(doSchema.blobs)
			.where(eq(doSchema.blobs.blobId, blobId))
			.limit(1)
			.get();

		return row ? toBlobRow(row) : null;
	}

	deleteBlobRecord(blobId: string): void {
		this.handle.db.transaction((tx) => {
			const existing = tx
				.select({
					sizeBytes: doSchema.blobs.sizeBytes,
				})
				.from(doSchema.blobs)
				.where(eq(doSchema.blobs.blobId, blobId))
				.limit(1)
				.get();

			tx.delete(doSchema.blobs)
				.where(eq(doSchema.blobs.blobId, blobId))
				.run();

			if (existing) {
				decrementStorageUsedBytes(tx, Number(existing.sizeBytes));
			}
		});
	}

	abortStagedBlob(blobId: string, now = Date.now()): void {
		this.handle.db.transaction((tx) => {
			const existing = tx
				.select({
					sizeBytes: doSchema.blobs.sizeBytes,
				})
				.from(doSchema.blobs)
				.where(
					and(
						eq(doSchema.blobs.blobId, blobId),
						eq(doSchema.blobs.state, "staged"),
					),
				)
				.limit(1)
				.get();
			if (!existing) {
				return;
			}

			if (this.isBlobPinned(blobId, false, now)) {
				return;
			}

			tx.delete(doSchema.blobs)
				.where(eq(doSchema.blobs.blobId, blobId))
				.run();
			decrementStorageUsedBytes(tx, Number(existing.sizeBytes));
		});
	}

	isBlobPinned(blobId: string, includeStaging = true, now = Date.now()): boolean {
		const row = this.handle
			.exec<{ found: number }>(
				`
				SELECT 1 AS found
				WHERE EXISTS (
					SELECT 1
					FROM entries
					WHERE entries.blob_id = ?
				)
				OR EXISTS (
					SELECT 1
					FROM entry_versions
					WHERE entry_versions.blob_id = ?
						AND entry_versions.expires_at > ?
				)
				OR (
					?
					AND EXISTS (
						SELECT 1
						FROM blobs
						WHERE blobs.blob_id = ?
							AND blobs.state = 'staged'
							AND blobs.delete_after > ?
					)
				)
				LIMIT 1
				`,
				blobId,
				blobId,
				now,
				includeStaging ? 1 : 0,
				blobId,
				now,
			)
			.toArray()[0];

		return !!row;
	}

	readBlobState(db: BlobDb, blobId: string): BlobState | null {
		const blob = db
			.select({
				state: doSchema.blobs.state,
			})
			.from(doSchema.blobs)
			.where(eq(doSchema.blobs.blobId, blobId))
			.limit(1)
			.get();

		return blob ? (blob.state as BlobState) : null;
	}

	restagePendingDeleteBlob(db: BlobDb, blobId: string, deleteAfter: number): void {
		db.update(doSchema.blobs)
			.set({
				state: "staged",
				deleteAfter,
			})
			.where(eq(doSchema.blobs.blobId, blobId))
			.run();
	}

	markBlobLive(db: BlobDb, blobId: string): void {
		db.update(doSchema.blobs)
			.set({
				state: "live",
				deleteAfter: null,
			})
			.where(eq(doSchema.blobs.blobId, blobId))
			.run();
	}

	markBlobPendingDeleteIfUnreferenced(
		db: BlobDb,
		blobId: string,
		deleteAfter: number,
	): void {
		const stillCurrent = db
			.select({
				found: sql<number>`1`,
			})
			.from(doSchema.entries)
			.where(eq(doSchema.entries.blobId, blobId))
			.limit(1)
			.get();

		if (stillCurrent) {
			return;
		}

		db.update(doSchema.blobs)
			.set({
				state: "pending_delete",
				deleteAfter,
			})
			.where(eq(doSchema.blobs.blobId, blobId))
			.run();
	}

}

function decrementStorageUsedBytes(db: BlobDb, sizeBytes: number): void {
	db.update(doSchema.coordinatorState)
		.set({
			storageUsedBytes: sql`max(0, ${doSchema.coordinatorState.storageUsedBytes} - ${sizeBytes})`,
		})
		.where(eq(doSchema.coordinatorState.id, 1))
		.run();
}

function toBlobRow(row: {
	blob_id: string;
	state: string;
	size_bytes: number;
	created_at: number;
	last_uploaded_at: number;
	delete_after: number | null;
}): BlobRow {
	return {
		blob_id: row.blob_id,
		state: row.state as BlobState,
		size_bytes: Number(row.size_bytes),
		created_at: Number(row.created_at),
		last_uploaded_at: Number(row.last_uploaded_at),
		delete_after: row.delete_after === null ? null : Number(row.delete_after),
	};
}
