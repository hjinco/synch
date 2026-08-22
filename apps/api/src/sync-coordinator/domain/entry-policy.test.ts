import { describe, expect, it } from "vitest";

import {
	decideDeletedEntryPurge,
	decideEntryMutation,
	isRestorePayloadCompatible,
} from "./entry-policy";

describe("entry policy", () => {
	it("returns an idempotent decision for a repeated mutation", () => {
		expect(
			decideEntryMutation({
				current: { revision: 3, lastMutationId: "mutation-1" },
				mutationId: "mutation-1",
				baseRevision: 3,
				op: "upsert",
				blobId: "blob-1",
				forcedHistoryBefore: null,
				now: 1_000,
			}),
		).toEqual({ kind: "idempotent" });
	});

	it("derives revision and history behavior for an accepted mutation", () => {
		const decision = decideEntryMutation({
			current: { revision: 2, lastMutationId: null },
			mutationId: "mutation-1",
			baseRevision: 2,
			op: "upsert",
			blobId: "blob-1",
			forcedHistoryBefore: null,
			now: 1_000_000,
		});

		expect(decision).toMatchObject({
			kind: "apply",
			previousRevision: 2,
			revision: 3,
			nextBlobId: "blob-1",
			nextDeleted: false,
			forcedHistoryBefore: null,
			captureAutoVersion: true,
		});
	});

	it("rejects purging a deleted entry with a stale revision", () => {
		expect(
			decideDeletedEntryPurge({
				current: { revision: 4, deleted: true },
				receivedRevision: 3,
				hasRestorableHistory: true,
			}),
		).toEqual({ kind: "stale_revision", expectedRevision: 4 });
	});

	it("matches restore payloads by operation and blob", () => {
		expect(
			isRestorePayloadCompatible({
				targetOp: "upsert",
				targetBlobId: "blob-1",
				restoreOp: "upsert",
				restoreBlobId: "blob-1",
			}),
		).toBe(true);
		expect(
			isRestorePayloadCompatible({
				targetOp: "upsert",
				targetBlobId: "blob-1",
				restoreOp: "delete",
				restoreBlobId: null,
			}),
		).toBe(false);
	});
});
