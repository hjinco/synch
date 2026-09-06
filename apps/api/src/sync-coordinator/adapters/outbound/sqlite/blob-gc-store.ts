import { and, asc, eq, gt, isNotNull, lte, ne, or, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/sqlite-core";

import * as doSchema from "../../../../db/do";
import type {
	BlobPendingDeleteFacts,
	BlobPendingDeleteTransaction,
	BlobGcDeleteResult,
	BlobGcStore,
} from "../../../application/ports/outbound/blob-gc-store";
import type { BlobRow, BlobState } from "../../../application/ports/outbound/storage-models";
import {
	blobUnreferenced,
	collectibleBlob,
} from "./blob-collectability";
import { readBlobReferenceFacts } from "./blob-reference-facts";
import type { CoordinatorDb, CoordinatorStorageHandle } from "./storage-handle";

type BlobDb = Pick<CoordinatorDb, "update">;

export class CoordinatorBlobGcStore implements BlobGcStore {
	constructor(private readonly handle: CoordinatorStorageHandle) {}

	expireEntryVersions(now: number): void {
		this.handle.db
			.delete(doSchema.entryVersions)
			.where(lte(doSchema.entryVersions.expiresAt, now))
			.run();
	}

	listCollectibleBlobs(now: number, limit: number): BlobRow[] {
		return this.handle.db
			.select()
			.from(doSchema.blobs)
			.where(collectibleBlob(now))
			.orderBy(asc(doSchema.blobs.deleteAfter), asc(doSchema.blobs.blobId))
			.limit(limit)
			.all()
			.map(toBlobRow);
	}

	readCollectibleBlob(blobId: string, now: number): BlobRow | null {
		const row = this.handle.db
			.select()
			.from(doSchema.blobs)
			.where(and(eq(doSchema.blobs.blobId, blobId), collectibleBlob(now)))
			.limit(1)
			.get();

		return row ? toBlobRow(row) : null;
	}

	withPendingDeleteTransaction(
		blobId: string,
		now: number,
		operation: (transaction: BlobPendingDeleteTransaction) => void,
	): void {
		this.handle.db.transaction((tx) => {
			const transaction: BlobPendingDeleteTransaction = {
				readFacts: (): BlobPendingDeleteFacts => {
					const blob = tx
						.select({
							state: doSchema.blobs.state,
							deleteAfter: doSchema.blobs.deleteAfter,
						})
						.from(doSchema.blobs)
						.where(eq(doSchema.blobs.blobId, blobId))
						.limit(1)
						.get();
					if (!blob) {
						return null;
					}

					const referenceFacts = readBlobReferenceFacts(tx, blobId, now);
					return {
						state: blob.state as BlobRow["state"],
						deleteAfter:
							blob.deleteAfter === null ? null : Number(blob.deleteAfter),
						hasCurrentReference: referenceFacts.hasCurrentReference,
						hasRetainedHistory: referenceFacts.hasRetainedHistory,
					};
				},
				markPendingDelete: (deleteAfter) => {
					const referenceFacts = readBlobReferenceFacts(tx, blobId, now);
					if (
						referenceFacts.hasCurrentReference ||
						referenceFacts.hasRetainedHistory
					) {
						return;
					}

					tx.update(doSchema.blobs)
						.set({
							state: "pending_delete",
							deleteAfter,
						})
						.where(
							and(
								eq(doSchema.blobs.blobId, blobId),
								ne(doSchema.blobs.state, "staged"),
							),
						)
						.run();
				},
			};

			operation(transaction);
		});
	}

	deleteCollectibleBlobs(blobIds: readonly string[], now: number): BlobRow[] {
		if (blobIds.length === 0) {
			return [];
		}

		// One JSON bind keeps this under Durable Object's 100 bound-parameter limit.
		return this.handle.db.transaction((tx) => {
			const deleted = tx
				.delete(doSchema.blobs)
				.where(
					and(
						sql`${doSchema.blobs.blobId} IN (SELECT value FROM json_each(${JSON.stringify(blobIds)}))`,
						collectibleBlob(now),
					),
				)
				.returning({
					blobId: doSchema.blobs.blobId,
					state: doSchema.blobs.state,
					sizeBytes: doSchema.blobs.sizeBytes,
					createdAt: doSchema.blobs.createdAt,
					lastUploadedAt: doSchema.blobs.lastUploadedAt,
					deleteAfter: doSchema.blobs.deleteAfter,
				})
				.all()
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

	readGcDeadlines(now: number): readonly number[] {
		const rows = unionAll(
			this.handle.db
				.select({ deadline: doSchema.blobs.deleteAfter })
				.from(doSchema.blobs)
				.where(
					and(
						eq(doSchema.blobs.state, "staged"),
						isNotNull(doSchema.blobs.deleteAfter),
						or(gt(doSchema.blobs.deleteAfter, now), blobUnreferenced(now)),
					),
				),
			this.handle.db
				.select({ deadline: doSchema.blobs.deleteAfter })
				.from(doSchema.blobs)
				.where(
					and(
						eq(doSchema.blobs.state, "pending_delete"),
						isNotNull(doSchema.blobs.deleteAfter),
						blobUnreferenced(now),
					),
				),
			this.handle.db
				.select({ deadline: doSchema.entryVersions.expiresAt })
				.from(doSchema.entryVersions)
				.where(isNotNull(doSchema.entryVersions.expiresAt)),
		)
			.orderBy(asc(doSchema.blobs.deleteAfter))
			.limit(1)
			.all();

		return rows.flatMap((row) =>
			row.deadline === null ? [] : [Number(row.deadline)],
		);
	}
}

type BlobSelectRow = typeof doSchema.blobs.$inferSelect;

function decrementStorageUsedBytes(db: BlobDb, sizeBytes: number): void {
	db.update(doSchema.coordinatorState)
		.set({
			storageUsedBytes: sql`max(0, ${doSchema.coordinatorState.storageUsedBytes} - ${sizeBytes})`,
		})
		.where(eq(doSchema.coordinatorState.id, 1))
		.run();
}

function toBlobRow(row: BlobSelectRow): BlobRow {
	return {
		blob_id: row.blobId,
		state: row.state as BlobState,
		size_bytes: Number(row.sizeBytes),
		created_at: Number(row.createdAt),
		last_uploaded_at: Number(row.lastUploadedAt),
		delete_after: row.deleteAfter === null ? null : Number(row.deleteAfter),
	};
}
