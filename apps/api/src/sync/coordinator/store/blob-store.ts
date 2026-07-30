import { and, eq, sql } from "drizzle-orm";

import * as doSchema from "../../../db/do";
import { DomainError } from "../../../errors";
import type { BlobRow, BlobState } from "../types";
import type { CoordinatorDb, CoordinatorStorageHandle } from "./storage-handle";

type BlobDb = Pick<CoordinatorDb, "delete" | "insert" | "select" | "update">;

export class CoordinatorBlobStore {
	constructor(private readonly handle: CoordinatorStorageHandle) {}

	async stageBlob(
		blobId: string,
		sizeBytes: number,
		now: number,
		deleteAfter: number,
	): Promise<void> {
		this.handle.db.transaction((tx) => {
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
				throw new DomainError(
					"sync_state_uninitialized",
					"vault sync state is not initialized",
				);
			}

			const storageLimitBytes = Number(storage.storageLimitBytes);
			const maxFileSizeBytes = Number(storage.maxFileSizeBytes);
			if (maxFileSizeBytes > 0 && sizeBytes > maxFileSizeBytes) {
				throw new DomainError(
					"file_too_large",
					`blob exceeds maximum file size of ${maxFileSizeBytes} bytes`,
					{ maxFileSizeBytes, sizeBytes },
				);
			}

			const existing = tx
				.select({
					state: doSchema.blobs.state,
					sizeBytes: doSchema.blobs.sizeBytes,
				})
				.from(doSchema.blobs)
				.where(eq(doSchema.blobs.blobId, blobId))
				.limit(1)
				.get();

			if (existing && this.isBlobPinned(blobId, false, now)) {
				throw new DomainError("blob_already_live", `blob ${blobId} is already live`, {
					blobId,
				});
			}
			if (existing && Number(existing.sizeBytes) !== sizeBytes) {
				throw new DomainError(
					"blob_size_changed",
					`blob ${blobId} size changed between staged uploads`,
					{ blobId, previousSizeBytes: Number(existing.sizeBytes), sizeBytes },
				);
			}

			if (!existing) {
				const usedBytes = Number(storage.usedBytes);
				if (
					storageLimitBytes > 0 &&
					usedBytes + sizeBytes > storageLimitBytes
				) {
					throw new DomainError(
						"quota_exceeded",
						`vault storage quota exceeded: ${usedBytes + sizeBytes}/${storageLimitBytes} bytes`,
						{ storageLimitBytes, sizeBytes, usedBytes },
					);
				}

				tx.update(doSchema.coordinatorState)
					.set({
						storageUsedBytes: usedBytes + sizeBytes,
					})
					.where(eq(doSchema.coordinatorState.id, 1))
					.run();
			}
			tx.insert(doSchema.blobs)
				.values({
					blobId,
					state: "staged",
					sizeBytes,
					createdAt: now,
					lastUploadedAt: now,
					deleteAfter,
				})
				.onConflictDoUpdate({
					target: doSchema.blobs.blobId,
					set: {
						state: "staged",
						lastUploadedAt: now,
						deleteAfter,
					},
				})
				.run();
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

	listBlobsReadyForDeletion(now: number, limit: number): BlobRow[] {
		this.deleteExpiredEntryVersions(now);
		return this.handle
			.exec<{
				blob_id: string;
				state: string;
				size_bytes: number;
				created_at: number;
				last_uploaded_at: number;
				delete_after: number | null;
			}>(
				`
				SELECT
					blobs.blob_id,
					blobs.state,
					blobs.size_bytes,
					blobs.created_at,
					blobs.last_uploaded_at,
					blobs.delete_after
				FROM blobs
				WHERE blobs.state IN ('staged', 'pending_delete')
					AND blobs.delete_after <= ?
					AND NOT EXISTS (
						SELECT 1
						FROM entries
						WHERE entries.blob_id = blobs.blob_id
					)
					AND NOT EXISTS (
						SELECT 1
						FROM entry_versions
						WHERE entry_versions.blob_id = blobs.blob_id
							AND entry_versions.expires_at > ?
					)
				ORDER BY blobs.delete_after ASC, blobs.blob_id ASC
				LIMIT ?
				`,
				now,
				now,
				limit,
			)
			.toArray()
			.map(toBlobRow);
	}

	deleteBlobIfCollectible(blobId: string, now = Date.now()): void {
		this.handle.db.transaction((tx) => {
			const collectible = this.handle
				.exec<{ size_bytes: number }>(
					`
					SELECT size_bytes
					FROM blobs
					WHERE blob_id = ?
						AND state IN ('staged', 'pending_delete')
						AND delete_after <= ?
						AND NOT EXISTS (
							SELECT 1
							FROM entries
							WHERE entries.blob_id = blobs.blob_id
						)
						AND NOT EXISTS (
							SELECT 1
							FROM entry_versions
							WHERE entry_versions.blob_id = blobs.blob_id
								AND entry_versions.expires_at > ?
						)
					LIMIT 1
					`,
					blobId,
					now,
					now,
				)
				.toArray()[0];
			if (!collectible) {
				return;
			}

			tx.delete(doSchema.blobs)
				.where(eq(doSchema.blobs.blobId, blobId))
				.run();
			decrementStorageUsedBytes(tx, Number(collectible.size_bytes));
		});
	}

	nextBlobGcAt(): number | null {
		const now = Date.now();
		const row = this.handle
			.exec<{ delete_after: number | null }>(
				`
					SELECT blobs.delete_after
					FROM blobs
					WHERE blobs.state = 'staged'
						AND blobs.delete_after IS NOT NULL
					UNION ALL
					SELECT blobs.delete_after
					FROM blobs
					WHERE blobs.state = 'pending_delete'
						AND blobs.delete_after IS NOT NULL
						AND NOT EXISTS (
							SELECT 1
							FROM entries
							WHERE entries.blob_id = blobs.blob_id
						)
						AND NOT EXISTS (
							SELECT 1
							FROM entry_versions
							WHERE entry_versions.blob_id = blobs.blob_id
								AND entry_versions.expires_at > ?
						)
					UNION ALL
					SELECT entry_versions.expires_at AS delete_after
					FROM entry_versions
					WHERE entry_versions.expires_at IS NOT NULL
				ORDER BY delete_after ASC
				LIMIT 1
				`,
				now,
			)
			.toArray()[0];

		return row?.delete_after ?? null;
	}

	markUnpinnedBlobsForDeletion(now: number): void {
		this.deleteExpiredEntryVersions(now);
		this.handle.exec(
			`
			UPDATE blobs
			SET state = 'pending_delete',
				delete_after = CASE
					WHEN delete_after IS NULL OR delete_after > ? THEN ?
					ELSE delete_after
				END
			WHERE state != 'staged'
				AND NOT EXISTS (
					SELECT 1
					FROM entries
					WHERE entries.blob_id = blobs.blob_id
				)
				AND NOT EXISTS (
					SELECT 1
					FROM entry_versions
					WHERE entry_versions.blob_id = blobs.blob_id
						AND entry_versions.expires_at > ?
				)
			`,
			now,
			now,
			now,
		);
	}

	markBlobPendingDeleteIfUnpinned(blobId: string, now: number): void {
		this.deleteExpiredEntryVersions(now);
		this.handle.exec(
			`
			UPDATE blobs
			SET state = 'pending_delete',
				delete_after = CASE
					WHEN delete_after IS NULL OR delete_after > ? THEN ?
					ELSE delete_after
				END
			WHERE blob_id = ?
				AND state != 'staged'
				AND NOT EXISTS (
					SELECT 1
					FROM entries
					WHERE entries.blob_id = blobs.blob_id
				)
				AND NOT EXISTS (
					SELECT 1
					FROM entry_versions
					WHERE entry_versions.blob_id = blobs.blob_id
						AND entry_versions.expires_at > ?
				)
			`,
			now,
			now,
			blobId,
			now,
		);
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

	private deleteExpiredEntryVersions(now: number): void {
		this.handle.exec(
			`
			DELETE FROM entry_versions
			WHERE expires_at <= ?
			`,
			now,
		);
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
