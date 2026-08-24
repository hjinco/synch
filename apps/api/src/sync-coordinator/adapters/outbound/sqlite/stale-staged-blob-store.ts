import { eq, sql } from "drizzle-orm";

import * as doSchema from "../../../../db/do";
import type {
	StaleStagedBlobStore,
	UnreferencedStagedBlobDeleteResult,
} from "../../../application/ports/outbound/stale-staged-blob-store";
import type { BlobRow, BlobState } from "../../../application/ports/outbound/storage-models";
import type { CoordinatorDb, CoordinatorStorageHandle } from "./storage-handle";

type BlobDb = Pick<CoordinatorDb, "delete" | "select" | "update">;

export class CoordinatorStaleStagedBlobStore implements StaleStagedBlobStore {
	constructor(private readonly handle: CoordinatorStorageHandle) {}

	listStaleStagedBlobs(now: number, staleAfterMs: number, limit: number): BlobRow[] {
		return this.handle
			.exec<BlobSqlRow>(
				`
				SELECT
					blob_id,
					state,
					size_bytes,
					created_at,
					last_uploaded_at,
					delete_after
				FROM blobs
				WHERE state = 'staged'
					AND created_at <= ?
				ORDER BY created_at ASC, blob_id ASC
				LIMIT ?
				`,
				now - staleAfterMs,
				limit,
			)
			.toArray()
			.map(toBlobRow);
	}

	deleteUnreferencedStagedBlob(
		blobId: string,
		now = Date.now(),
	): UnreferencedStagedBlobDeleteResult {
		return this.handle.db.transaction((tx) => {
			const existing = tx
				.select({
					state: doSchema.blobs.state,
					sizeBytes: doSchema.blobs.sizeBytes,
				})
				.from(doSchema.blobs)
				.where(eq(doSchema.blobs.blobId, blobId))
				.limit(1)
				.get();
			if (!existing) {
				return "missing";
			}
			if (existing.state !== "staged" || isBlobPinned(this.handle, blobId, now)) {
				return "referenced";
			}

			tx.delete(doSchema.blobs)
				.where(eq(doSchema.blobs.blobId, blobId))
				.run();
			decrementStorageUsedBytes(tx, Number(existing.sizeBytes));
			return "deleted";
		});
	}
}

function isBlobPinned(
	handle: CoordinatorStorageHandle,
	blobId: string,
	now: number,
): boolean {
	const row = handle
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
			LIMIT 1
			`,
			blobId,
			blobId,
			now,
		)
		.toArray()[0];

	return !!row;
}

function decrementStorageUsedBytes(db: BlobDb, sizeBytes: number): void {
	db.update(doSchema.coordinatorState)
		.set({
			storageUsedBytes: sql`max(0, ${doSchema.coordinatorState.storageUsedBytes} - ${sizeBytes})`,
		})
		.where(eq(doSchema.coordinatorState.id, 1))
		.run();
}

type BlobSqlRow = {
	blob_id: string;
	state: string;
	size_bytes: number;
	created_at: number;
	last_uploaded_at: number;
	delete_after: number | null;
};

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
