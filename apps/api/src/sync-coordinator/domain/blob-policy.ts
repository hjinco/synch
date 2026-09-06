export type BlobLifecycleState = "staged" | "live" | "pending_delete";

export type ExistingBlobForStage = {
	state: BlobLifecycleState;
	sizeBytes: number;
	createdAt: number;
};

export type BlobStageDecision =
	| { kind: "sync_paused"; reason: string }
	| {
			kind: "rejected";
			code:
				| "file_too_large"
				| "blob_already_live"
				| "blob_size_changed"
				| "quota_exceeded";
			maxFileSizeBytes?: number;
			previousSizeBytes?: number;
			sizeBytes: number;
			storageLimitBytes?: number;
			usedBytes?: number;
	  }
	| { kind: "staged"; storageDeltaBytes: number };

/**
 * Stale-staged pauses are persisted as human-readable text; the prefix is the
 * stable identifier used to recognize them when reading stored pause state.
 * Follow-up: persist a stable pause-reason id instead of matching on text.
 */
export const STALE_STAGED_BLOB_PAUSE_REASON_PREFIX = "staged blob ";

export function isStaleStagedBlobPauseReason(reason: string): boolean {
	return reason.startsWith(STALE_STAGED_BLOB_PAUSE_REASON_PREFIX);
}

export function decideBlobStage(input: {
	blobId: string;
	sizeBytes: number;
	now: number;
	staleAfterMs: number;
	existing: ExistingBlobForStage | null;
	isPinned: boolean;
	storageUsedBytes: number;
	storageLimitBytes: number;
	maxFileSizeBytes: number;
}): BlobStageDecision {
	if (
		input.existing?.state === "staged" &&
		input.now - input.existing.createdAt >= input.staleAfterMs
	) {
		return {
			kind: "sync_paused",
			reason: `staged blob ${input.blobId} remained staged for at least one hour`,
		};
	}

	if (input.maxFileSizeBytes > 0 && input.sizeBytes > input.maxFileSizeBytes) {
		return {
			kind: "rejected",
			code: "file_too_large",
			maxFileSizeBytes: input.maxFileSizeBytes,
			sizeBytes: input.sizeBytes,
		};
	}

	if (input.existing && input.isPinned) {
		return {
			kind: "rejected",
			code: "blob_already_live",
			sizeBytes: input.sizeBytes,
		};
	}

	if (input.existing && input.existing.sizeBytes !== input.sizeBytes) {
		return {
			kind: "rejected",
			code: "blob_size_changed",
			previousSizeBytes: input.existing.sizeBytes,
			sizeBytes: input.sizeBytes,
		};
	}

	if (
		!input.existing &&
		input.storageLimitBytes > 0 &&
		input.storageUsedBytes + input.sizeBytes > input.storageLimitBytes
	) {
		return {
			kind: "rejected",
			code: "quota_exceeded",
			storageLimitBytes: input.storageLimitBytes,
			sizeBytes: input.sizeBytes,
			usedBytes: input.storageUsedBytes,
		};
	}

	return {
		kind: "staged",
		storageDeltaBytes: input.existing ? 0 : input.sizeBytes,
	};
}
