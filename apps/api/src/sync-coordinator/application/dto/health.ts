export type VaultSyncHealthStatus = "ok" | "warning" | "critical" | "unknown";

export type VaultSyncStatusSummary = {
	vaultId: string;
	healthStatus: VaultSyncHealthStatus;
	healthReasons: string[];
	currentCursor: number;
	entryCount: number;
	liveBlobCount: number;
	stagedBlobCount: number;
	pendingDeleteBlobCount: number;
	storageUsedBytes: number;
	storageLimitBytes: number;
	activeLocalVaultCount: number;
	websocketCount: number;
	oldestStagedBlobAgeMs: number | null;
	oldestPendingDeleteAgeMs: number | null;
	lastCommitAt: number | null;
	lastGcAt: number | null;
};
