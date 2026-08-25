export type SyncPauseState = { pausedAt: number; reason: string };

export type SyncRepairIssue =
	| "unsupported_pause_reason"
	| "referenced_staged_blob"
	| "blob_storage_delete_failed"
	| "repair_limit_exceeded";

export type SyncRepairResult = {
	status: "repaired" | "not_paused" | "manual_repair_required";
	deletedStagedBlobCount: number;
	remainingStaleStagedBlobCount: number;
	nextGcAt: number | null;
	pause: SyncPauseState | null;
	issue?: SyncRepairIssue;
};
