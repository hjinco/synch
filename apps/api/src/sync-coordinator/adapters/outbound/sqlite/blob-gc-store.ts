import { eq, sql } from "drizzle-orm";

import * as doSchema from "../../../../db/do";
import {
	decidePendingDelete,
	earliestGcDeadline,
} from "../../../domain/blob-gc-policy";
import type {
	BlobGcDeleteResult,
	BlobGcStore,
} from "../../../application/ports/outbound/blob-gc-store";
import type { BlobRow, BlobState } from "../../../application/ports/outbound/storage-models";
import {
	BLOB_UNREFERENCED_SQL,
	COLLECTIBLE_BLOB_SQL,
} from "./blob-collectability";
import type { CoordinatorDb, CoordinatorStorageHandle } from "./storage-handle";

type BlobDb = Pick<CoordinatorDb, "update">;

export class CoordinatorBlobGcStore implements BlobGcStore {
	constructor(private readonly handle: CoordinatorStorageHandle) {}

	expireEntryVersions(now: number): void {
		this.handle.exec(
			`
			DELETE FROM entry_versions
			WHERE expires_at <= ?
			`,
			now,
		);
	}

	listCollectibleBlobs(now: number, limit: number): BlobRow[] {
		return this.handle
			.exec<BlobSqlRow>(
				`
				SELECT
					blobs.blob_id,
					blobs.state,
					blobs.size_bytes,
					blobs.created_at,
					blobs.last_uploaded_at,
					blobs.delete_after
				FROM blobs
				WHERE ${COLLECTIBLE_BLOB_SQL}
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

	readCollectibleBlob(blobId: string, now: number): BlobRow | null {
		const row = this.handle
			.exec<BlobSqlRow>(
				`
				SELECT
					blobs.blob_id,
					blobs.state,
					blobs.size_bytes,
					blobs.created_at,
					blobs.last_uploaded_at,
					blobs.delete_after
				FROM blobs
				WHERE blobs.blob_id = ?
					AND ${COLLECTIBLE_BLOB_SQL}
				LIMIT 1
				`,
				blobId,
				now,
				now,
			)
			.toArray()[0];

		return row ? toBlobRow(row) : null;
	}

	markBlobPendingDeleteIfUnpinned(blobId: string, now: number): void {
		const row = this.handle
			.exec<{
				state: string;
				delete_after: number | null;
				has_current_reference: number;
				has_retained_history: number;
			}>(
				`
				SELECT
					state,
					delete_after,
					EXISTS (
						SELECT 1
						FROM entries
						WHERE entries.blob_id = blobs.blob_id
					) AS has_current_reference,
					EXISTS (
						SELECT 1
						FROM entry_versions
						WHERE entry_versions.blob_id = blobs.blob_id
							AND entry_versions.expires_at > ?
					) AS has_retained_history
				FROM blobs
				WHERE blob_id = ?
				LIMIT 1
				`,
				now,
				blobId,
			)
			.toArray()[0];
		if (!row) {
			return;
		}

		const decision = decidePendingDelete(
			{
				state: row.state as BlobRow["state"],
				deleteAfter: row.delete_after === null ? null : Number(row.delete_after),
				hasCurrentReference: Number(row.has_current_reference) !== 0,
				hasRetainedHistory: Number(row.has_retained_history) !== 0,
			},
			now,
		);
		if (decision.kind !== "mark_pending_delete") {
			return;
		}

		this.handle.exec(
			`
			UPDATE blobs
			SET state = 'pending_delete',
				delete_after = ?
			WHERE blob_id = ?
				AND state != 'staged'
				AND ${BLOB_UNREFERENCED_SQL}
			`,
			decision.deleteAfter,
			blobId,
			now,
		);
	}

	deleteCollectibleBlobs(blobIds: readonly string[], now: number): BlobRow[] {
		if (blobIds.length === 0) {
			return [];
		}

		// One JSON bind keeps this under Durable Object's 100 bound-parameter limit.
		return this.handle.db.transaction((tx) => {
			const deleted = this.handle
				.exec<BlobSqlRow>(
					`
					DELETE FROM blobs
					WHERE blobs.blob_id IN (SELECT value FROM json_each(?))
						AND ${COLLECTIBLE_BLOB_SQL}
					RETURNING
						blobs.blob_id,
						blobs.state,
						blobs.size_bytes,
						blobs.created_at,
						blobs.last_uploaded_at,
						blobs.delete_after
					`,
					JSON.stringify(blobIds),
					now,
					now,
				)
				.toArray()
				.map(toBlobRow);
			const reclaimedBytes = deleted.reduce(
				(total, blob) => total + blob.size_bytes,
				0,
			);
			if (reclaimedBytes > 0) {
				decrementStorageUsedBytes(tx, reclaimedBytes);
			}
			return deleted;
		});
	}

	deleteBlobIfCollectible(blobId: string, now: number): BlobGcDeleteResult {
		return this.deleteCollectibleBlobs([blobId], now).length > 0 ? "deleted" : "skipped";
	}

	nextGcAt(now: number): number | null {
		const rows = this.handle
			.exec<{ delete_after: number | null }>(
				`
					SELECT blobs.delete_after
					FROM blobs
					WHERE blobs.state = 'staged'
						AND blobs.delete_after IS NOT NULL
						AND (
							blobs.delete_after > ?
							OR ${BLOB_UNREFERENCED_SQL}
						)
					UNION ALL
					SELECT blobs.delete_after
					FROM blobs
					WHERE blobs.state = 'pending_delete'
						AND blobs.delete_after IS NOT NULL
						AND ${BLOB_UNREFERENCED_SQL}
					UNION ALL
					SELECT entry_versions.expires_at AS delete_after
					FROM entry_versions
					WHERE entry_versions.expires_at IS NOT NULL
				ORDER BY delete_after ASC
				LIMIT 1
				`,
				now,
				now,
				now,
			)
			.toArray();

		return earliestGcDeadline(
			rows.flatMap((row) =>
				row.delete_after === null ? [] : [Number(row.delete_after)],
			),
			now,
		);
	}
}

type BlobSqlRow = {
	blob_id: string;
	state: string;
	size_bytes: number;
	created_at: number;
	last_uploaded_at: number;
	delete_after: number | null;
};

function decrementStorageUsedBytes(db: BlobDb, sizeBytes: number): void {
	db.update(doSchema.coordinatorState)
		.set({
			storageUsedBytes: sql`max(0, ${doSchema.coordinatorState.storageUsedBytes} - ${sizeBytes})`,
		})
		.where(eq(doSchema.coordinatorState.id, 1))
		.run();
}

function toBlobRow(row: BlobSqlRow): BlobRow {
	return {
		blob_id: row.blob_id,
		state: row.state as BlobState,
		size_bytes: Number(row.size_bytes),
		created_at: Number(row.created_at),
		last_uploaded_at: Number(row.last_uploaded_at),
		delete_after: row.delete_after === null ? null : Number(row.delete_after),
	};
}
