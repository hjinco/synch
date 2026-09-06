import type { SQL } from "drizzle-orm";
import { and, eq, inArray, lte, not } from "drizzle-orm";
import * as doSchema from "../../../../db/do";
import {
	currentBlobReference,
	retainedBlobReference,
} from "./blob-reference-facts";

/**
 * SQL projection of domain/blob-gc-policy for filtering before LIMIT and
 * guarding writes. blob-collectability.test.ts checks agreement with the
 * domain at state, reference, expiry and grace-period boundaries.
 * Requires blobs as the outer query table.
 */
export function blobUnreferenced(now: number): SQL {
	return and(
		not(currentBlobReference()),
		not(retainedBlobReference(now)),
	) as SQL;
}
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
