import type { VaultSyncStatusSummary } from "../../dto/health";
import type { StorageStatusSnapshot } from "../../dto/types";

export interface HealthStateStore {
	recordGcCompleted(now?: number): void;
	readHealthSummary(now: number, activeCursorTtlMs: number): VaultSyncStatusSummary | null;
	readStorageStatus(): StorageStatusSnapshot;
}

export interface HealthSummaryScheduler {
	scheduleSummaryFlush(now?: number): Promise<void>;
}

export interface PurgedBlobCollector {
	collectPurgedBlobs(vaultId: string, blobIds: readonly string[]): Promise<void>;
}
