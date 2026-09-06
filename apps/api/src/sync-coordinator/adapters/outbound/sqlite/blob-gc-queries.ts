import { and, asc, eq, getTableColumns, gt, isNotNull, or } from "drizzle-orm";
import { unionAll } from "drizzle-orm/sqlite-core";
import * as doSchema from "../../../../db/do";
import type {
	BlobGcCandidate,
	BlobGcQueries,
} from "../../../application/ports/outbound/blob-gc-queries";
import { blobUnreferenced, collectibleBlob } from "./blob-collectability";
import { blobReferenceColumns } from "./blob-reference-facts";
import { toBlobRow } from "./blob-store";
import type { CoordinatorStorageHandle } from "./storage-handle";

export class CoordinatorBlobGcQueries implements BlobGcQueries {
	constructor(private readonly handle: CoordinatorStorageHandle) {}
	listCollectibleBlobs(now: number, limit: number): BlobGcCandidate[] {
		return this.handle.db
			.select({
				...getTableColumns(doSchema.blobs),
				...blobReferenceColumns(now),
			})
			.from(doSchema.blobs)
			.where(collectibleBlob(now))
			.orderBy(asc(doSchema.blobs.deleteAfter), asc(doSchema.blobs.blobId))
			.limit(limit)
			.all()
			.map(toCandidate);
	}

	readCollectibleBlob(blobId: string, now: number): BlobGcCandidate | null {
		const row = this.handle.db
			.select({
				...getTableColumns(doSchema.blobs),
				...blobReferenceColumns(now),
			})
			.from(doSchema.blobs)
			.where(and(eq(doSchema.blobs.blobId, blobId), collectibleBlob(now)))
			.limit(1)
			.get();

		return row ? toCandidate(row) : null;
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

function toCandidate(
	row: typeof doSchema.blobs.$inferSelect & {
		hasCurrentReference: number;
		hasRetainedHistory: number;
	},
): BlobGcCandidate {
	return {
		...toBlobRow(row),
		referenceFacts: {
			hasCurrentReference: Boolean(row.hasCurrentReference),
			hasRetainedHistory: Boolean(row.hasRetainedHistory),
		},
	};
}
