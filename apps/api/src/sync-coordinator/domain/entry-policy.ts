export type EntryVersionCaptureReason =
	| "auto"
	| "before_delete"
	| "before_restore"
	| "manual";

export const AUTO_ENTRY_VERSION_BUCKET_MS = 5 * 60 * 1000;

export type EntryMutationDecision =
	| { kind: "idempotent" }
	| {
			kind: "stale_revision";
			expectedBaseRevision: number;
			receivedBaseRevision: number;
	  }
	| {
			kind: "apply";
			previousRevision: number;
			revision: number;
			nextBlobId: string | null;
			nextDeleted: boolean;
			forcedHistoryBefore: EntryVersionCaptureReason | null;
			captureAutoVersion: boolean;
			autoVersionBucketStart: number | null;
	  };

export function decideEntryMutation(input: {
	current: { revision: number; lastMutationId: string | null } | null;
	mutationId: string;
	baseRevision: number;
	op: "upsert" | "delete";
	blobId: string | null;
	forcedHistoryBefore: EntryVersionCaptureReason | null;
	now: number;
}): EntryMutationDecision {
	if (input.current?.lastMutationId === input.mutationId) {
		return { kind: "idempotent" };
	}

	const previousRevision = input.current?.revision ?? 0;
	if (previousRevision !== input.baseRevision) {
		return {
			kind: "stale_revision",
			expectedBaseRevision: previousRevision,
			receivedBaseRevision: input.baseRevision,
		};
	}

	const forcedHistoryBefore =
		input.op === "delete"
			? "before_delete"
			: input.forcedHistoryBefore;
	const captureAutoVersion = !forcedHistoryBefore && input.baseRevision > 0;

	return {
		kind: "apply",
		previousRevision,
		revision: previousRevision + 1,
		nextBlobId: input.op === "delete" ? null : input.blobId,
		nextDeleted: input.op === "delete",
		forcedHistoryBefore,
		captureAutoVersion,
		autoVersionBucketStart: captureAutoVersion
			? Math.floor(input.now / AUTO_ENTRY_VERSION_BUCKET_MS) *
				AUTO_ENTRY_VERSION_BUCKET_MS
			: null,
	};
}

export function isCurrentRevision(
	currentRevision: number,
	receivedBaseRevision: number,
): boolean {
	return currentRevision === receivedBaseRevision;
}

export function isRestorePayloadCompatible(input: {
	targetOp: "upsert" | "delete";
	targetBlobId: string | null;
	restoreOp: "upsert" | "delete";
	restoreBlobId: string | null;
}): boolean {
	return (
		input.targetOp === input.restoreOp &&
		input.targetBlobId === input.restoreBlobId
	);
}

export type DeletedEntryPurgeDecision =
	| { kind: "not_found" }
	| { kind: "not_deleted" }
	| { kind: "stale_revision"; expectedRevision: number }
	| { kind: "no_history" }
	| { kind: "accepted" };

export function decideDeletedEntryPurge(input: {
	current: { revision: number; deleted: boolean } | null;
	receivedRevision: number;
	hasRestorableHistory: boolean;
}): DeletedEntryPurgeDecision {
	if (!input.current) {
		return { kind: "not_found" };
	}
	if (!input.current.deleted) {
		return { kind: "not_deleted" };
	}
	if (input.current.revision !== input.receivedRevision) {
		return {
			kind: "stale_revision",
			expectedRevision: input.current.revision,
		};
	}
	if (!input.hasRestorableHistory) {
		return { kind: "no_history" };
	}
	return { kind: "accepted" };
}
