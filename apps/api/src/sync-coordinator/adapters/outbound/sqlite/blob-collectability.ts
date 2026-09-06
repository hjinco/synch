import { and, eq, gt, inArray, lte, notExists, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/sqlite-core";

import * as doSchema from "../../../../db/do";

/**
 * Drizzle mirror of the reference facts in domain/blob-gc-policy
 * (hasCurrentReference/hasRetainedHistory). Keep in lockstep with
 * decideBlobCollection/decidePendingDelete; the shared predicates are
 * covered by blob-store and blob-gc-service tests.
 */

const queryBuilder = new QueryBuilder();

/**
 * Blob is not referenced by a current entry or an unexpired version.
 * Requires `doSchema.blobs` to be the outer query's table so the
 * correlated `blobs.blob_id` references resolve.
 */
export function blobUnreferenced(now: number): SQL {
	return and(
		notExists(
			queryBuilder
				.select({ one: sql`1` })
				.from(doSchema.entries)
				.where(eq(doSchema.entries.blobId, doSchema.blobs.blobId)),
		),
		notExists(
			queryBuilder
				.select({ one: sql`1` })
				.from(doSchema.entryVersions)
				.where(
					and(
						eq(doSchema.entryVersions.blobId, doSchema.blobs.blobId),
						gt(doSchema.entryVersions.expiresAt, now),
					),
				),
		),
	) as SQL;
}

/** Staged or pending_delete blob whose grace period has passed and is unreferenced. */
export function collectibleBlob(now: number): SQL {
	return and(
		inArray(doSchema.blobs.state, ["staged", "pending_delete"]),
		lte(doSchema.blobs.deleteAfter, now),
		blobUnreferenced(now),
	) as SQL;
}

/** Pending-delete blob that GC can collect right now. */
export function collectiblePendingDelete(now: number): SQL {
	return and(
		eq(doSchema.blobs.state, "pending_delete"),
		lte(doSchema.blobs.deleteAfter, now),
		blobUnreferenced(now),
	) as SQL;
}
