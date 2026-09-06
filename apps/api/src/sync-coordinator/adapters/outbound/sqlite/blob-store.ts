import { and, asc, eq, lte, sql } from "drizzle-orm";
import * as doSchema from "../../../../db/do";
import type { BlobStore } from "../../../application/ports/outbound/blob-store";
import type {
	BlobRow,
	BlobState,
} from "../../../application/ports/outbound/storage-models";
import { collectibleBlob } from "./blob-collectability";
import type { CoordinatorStorageHandle } from "./storage-handle";

export class CoordinatorBlobStore implements BlobStore {
	constructor(private readonly handle: CoordinatorStorageHandle) {}
	readBlob(blobId: string): BlobRow | null {
		const row = this.handle.db
			.select()
			.from(doSchema.blobs)
			.where(eq(doSchema.blobs.blobId, blobId))
			.get();
		return row ? toBlobRow(row) : null;
	}
	persistStage(
		blobId: string,
		input: { sizeBytes: number; now: number; deleteAfter: number },
	): void {
		this.handle.db
			.insert(doSchema.blobs)
			.values({
				blobId,
				state: "staged",
				sizeBytes: input.sizeBytes,
				createdAt: input.now,
				lastUploadedAt: input.now,
				deleteAfter: input.deleteAfter,
			})
			.onConflictDoUpdate({
				target: doSchema.blobs.blobId,
				set: {
					state: "staged",
					lastUploadedAt: input.now,
					deleteAfter: input.deleteAfter,
				},
			})
			.run();
	}
	updateState(
		blobId: string,
		state: BlobState,
		deleteAfter: number | null,
	): void {
		this.handle.db
			.update(doSchema.blobs)
			.set({ state, deleteAfter })
			.where(eq(doSchema.blobs.blobId, blobId))
			.run();
	}
	deleteBlobRecord(blobId: string, expectedState?: BlobState): BlobRow[] {
		return this.handle.db
			.delete(doSchema.blobs)
			.where(
				and(
					eq(doSchema.blobs.blobId, blobId),
					expectedState === undefined
						? undefined
						: eq(doSchema.blobs.state, expectedState),
				),
			)
			.returning()
			.all()
			.map(toBlobRow);
	}
	deleteCollectibleBlobs(blobIds: readonly string[], now: number): BlobRow[] {
		if (blobIds.length === 0) return [];
		// One JSON bind keeps bulk deletion under the Durable Object parameter limit.
		return this.handle.db
			.delete(doSchema.blobs)
			.where(
				and(
					sql`${doSchema.blobs.blobId} IN (SELECT value FROM json_each(${JSON.stringify(blobIds)}))`,
					collectibleBlob(now),
				),
			)
			.returning()
			.all()
			.map(toBlobRow);
	}
	listStaleStagedBlobs(createdBefore: number, limit: number): BlobRow[] {
		return this.handle.db
			.select()
			.from(doSchema.blobs)
			.where(
				and(
					eq(doSchema.blobs.state, "staged"),
					lte(doSchema.blobs.createdAt, createdBefore),
				),
			)
			.orderBy(asc(doSchema.blobs.createdAt), asc(doSchema.blobs.blobId))
			.limit(limit)
			.all()
			.map(toBlobRow);
	}
}
export function toBlobRow(row: typeof doSchema.blobs.$inferSelect): BlobRow {
	return {
		blob_id: row.blobId,
		state: row.state as BlobState,
		size_bytes: Number(row.sizeBytes),
		created_at: Number(row.createdAt),
		last_uploaded_at: Number(row.lastUploadedAt),
		delete_after: row.deleteAfter === null ? null : Number(row.deleteAfter),
	};
}
