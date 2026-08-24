import type { VaultHealthSnapshot } from "../../dto/health";
import type { StorageStatusSnapshot } from "../../dto/types";

export interface HealthStateStore {
	recordGcCompleted(now?: number): void;
	readHealthSnapshot(now: number, activeCursorTtlMs: number): VaultHealthSnapshot | null;
	readStorageStatus(): StorageStatusSnapshot;
}

export interface HealthSummaryScheduler {
	scheduleSummaryFlush(now?: number): Promise<void>;
}
