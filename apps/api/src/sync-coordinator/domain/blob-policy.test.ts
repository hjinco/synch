import { describe, expect, it } from "vitest";

import { decideBlobStage } from "./blob-policy";

const baseInput = {
	blobId: "blob-1",
	sizeBytes: 100,
	now: 1_000,
	staleAfterMs: 100,
	existing: null,
	isPinned: false,
	storageUsedBytes: 500,
	storageLimitBytes: 1_000,
	maxFileSizeBytes: 1_000,
};

describe("decideBlobStage", () => {
	it("pauses sync for a stale staged blob before other checks", () => {
		const decision = decideBlobStage({
			...baseInput,
			existing: { state: "staged", sizeBytes: 100, createdAt: 1 },
		});

		expect(decision).toEqual({
			kind: "sync_paused",
			reason: "staged blob blob-1 remained staged for at least one hour",
		});
	});

	it("rejects a file over the configured maximum", () => {
		const decision = decideBlobStage({
			...baseInput,
			sizeBytes: 1_001,
		});

		expect(decision).toMatchObject({
			kind: "rejected",
			code: "file_too_large",
		});
	});

	it("does not charge storage again when restaging an existing blob", () => {
		const decision = decideBlobStage({
			...baseInput,
			existing: { state: "pending_delete", sizeBytes: 100, createdAt: 900 },
		});

		expect(decision).toEqual({ kind: "staged", storageDeltaBytes: 0 });
	});

	it("rejects a new blob that exceeds the storage quota", () => {
		const decision = decideBlobStage({
			...baseInput,
			sizeBytes: 501,
		});

		expect(decision).toMatchObject({
			kind: "rejected",
			code: "quota_exceeded",
		});
	});
});
