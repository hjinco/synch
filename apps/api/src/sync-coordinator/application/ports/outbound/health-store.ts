import type { VaultSyncHealthStatus } from "../../../domain/health-policy";
import type { StorageStatusSnapshot } from "../../dto/types";

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

export interface HealthStateStore {
	recordGcCompleted(now?: number): void;
	readHealthSnapshot(now: number, activeCursorTtlMs: number): VaultHealthSnapshot | null;
	readStorageStatus(): StorageStatusSnapshot;
}

export interface VaultSyncStatusWriter {
	upsert(summary: VaultSyncStatusSummary, flushedAt: number): Promise<void>;
}
