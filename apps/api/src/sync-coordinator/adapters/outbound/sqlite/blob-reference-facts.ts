import { and, eq, exists, gt, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/sqlite-core";

import * as doSchema from "../../../../db/do";
import type { BlobReferenceFacts } from "../../../domain/blob-gc-policy";
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

	return {
		hasCurrentReference: currentReference !== undefined,
		hasRetainedHistory: retainedHistory !== undefined,
	};
}

const queryBuilder = new QueryBuilder();

export function currentBlobReference() {
	return exists(
		queryBuilder
			.select({ one: sql`1` })
			.from(doSchema.entries)
			.where(eq(doSchema.entries.blobId, doSchema.blobs.blobId)),
	);
}
export function retainedBlobReference(now: number) {
	return exists(
		queryBuilder
			.select({ one: sql`1` })
			.from(doSchema.entryVersions)
			.where(
				and(
					eq(doSchema.entryVersions.blobId, doSchema.blobs.blobId),
					gt(doSchema.entryVersions.expiresAt, now),
				),
			),
	);
}
/**
 * Correlated facts for a batched blobs query; the outer table must be blobs.
 * Use subquery builders so Drizzle retains table qualification inside SELECT expressions.
 */
export function blobReferenceColumns(now: number) {
	return {
		hasCurrentReference: sql<number>`${currentBlobReference()}`,
		hasRetainedHistory: sql<number>`${retainedBlobReference(now)}`,
	};
}
