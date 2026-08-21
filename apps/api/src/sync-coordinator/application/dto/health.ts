import type { VaultSyncHealthStatus } from "../../domain/health-policy";

export type { VaultSyncHealthStatus };

export type VaultHealthSnapshot = {
	vaultId: string;
	currentCursor: number;
	entryCount: number;
	liveBlobCount: number;
	stagedBlobCount: number;
	pendingDeleteBlobCount: number;
	collectiblePendingDeleteBlobCount: number;
	storageUsedBytes: number;
	storageLimitBytes: number;
	activeLocalVaultCount: number;
	websocketCount: number;
	oldestStagedBlobAgeMs: number | null;
	oldestPendingDeleteAgeMs: number | null;
	lastCommitAt: number | null;
	lastGcAt: number | null;
};

export type VaultSyncStatusSummary = VaultHealthSnapshot & {
	healthStatus: VaultSyncHealthStatus;
	healthReasons: string[];
};
