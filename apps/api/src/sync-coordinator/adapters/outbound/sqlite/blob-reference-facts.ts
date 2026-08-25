import { and, eq, gt, sql } from "drizzle-orm";

import * as doSchema from "../../../../db/do";
import type {
	BlobMutationFacts,
	BlobReferenceFacts,
} from "../../../application/ports/outbound/blob-state-store";
import type { BlobState } from "../../../application/ports/outbound/storage-models";
import type { CoordinatorDb } from "./storage-handle";

type BlobReferenceDb = Pick<CoordinatorDb, "select">;

/**
 * Reads the facts shared by blob staging, repair, and garbage collection.
 * The database argument may be a transaction, so callers keep the reference
 * check in the same transaction as the state transition they are protecting.
 */
export function readBlobReferenceFacts(
	db: BlobReferenceDb,
	blobId: string,
	now: number,
): BlobReferenceFacts {
	const currentReference = db
		.select({ found: sql<number>`1` })
		.from(doSchema.entries)
		.where(eq(doSchema.entries.blobId, blobId))
		.limit(1)
		.get();
	const retainedHistory = db
		.select({ found: sql<number>`1` })
		.from(doSchema.entryVersions)
		.where(
			and(
				eq(doSchema.entryVersions.blobId, blobId),
				gt(doSchema.entryVersions.expiresAt, now),
			),
		)
		.limit(1)
		.get();
	const activeStaging = db
		.select({ found: sql<number>`1` })
		.from(doSchema.blobs)
		.where(
			and(
				eq(doSchema.blobs.blobId, blobId),
				eq(doSchema.blobs.state, "staged"),
				gt(doSchema.blobs.deleteAfter, now),
			),
		)
		.limit(1)
		.get();

	return {
		hasCurrentReference: currentReference !== undefined,
		hasRetainedHistory: retainedHistory !== undefined,
		hasActiveStaging: activeStaging !== undefined,
	};
}

export function readBlobMutationFacts(
	db: BlobReferenceDb,
	blobId: string,
	now: number,
): BlobMutationFacts {
	const blob = db
		.select({
			state: doSchema.blobs.state,
			sizeBytes: doSchema.blobs.sizeBytes,
		})
		.from(doSchema.blobs)
		.where(eq(doSchema.blobs.blobId, blobId))
		.limit(1)
		.get();

	return {
		blob: blob
			? {
					state: blob.state as BlobState,
					sizeBytes: Number(blob.sizeBytes),
				}
			: null,
		referenceFacts: readBlobReferenceFacts(db, blobId, now),
	};
}
