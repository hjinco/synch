import { and, eq, sql } from "drizzle-orm";

import * as doSchema from "../../../../db/do";
import type {
	StaleStagedBlobFacts,
	StaleStagedBlobStore,
	StaleStagedBlobTransaction,
} from "../../../application/ports/outbound/stale-staged-blob-store";
import type { BlobRow, BlobState } from "../../../application/ports/outbound/storage-models";
import { readBlobMutationFacts } from "./blob-reference-facts";
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

	withStagedBlobTransaction<T>(
		blobId: string,
		now: number,
		operation: (transaction: StaleStagedBlobTransaction) => T,
	): T {
		return this.handle.db.transaction((tx) => {
			const transaction: StaleStagedBlobTransaction = {
				readFacts: (): StaleStagedBlobFacts =>
					readBlobMutationFacts(tx, blobId, now),
				deleteStagedBlob: () => {
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

					tx.delete(doSchema.blobs)
						.where(
							and(
								eq(doSchema.blobs.blobId, blobId),
								eq(doSchema.blobs.state, "staged"),
							),
						)
						.run();
					decrementStorageUsedBytes(tx, Number(existing.sizeBytes));
				},
			};

			return operation(transaction);
		});
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
