import type { VaultStateStore } from "./vault-state-store";
export interface CoordinatorStateStore extends VaultStateStore {
	recordGcCompleted(now: number): void;
	readStorageUsedBytes(): number;
	adjustStorageUsedBytes(delta: number): void;
	pauseSync(now: number, reason: string): void;
	saveCommit(cursor: number, now: number): void;
}
