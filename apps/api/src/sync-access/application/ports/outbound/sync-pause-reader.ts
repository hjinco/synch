import type { SyncPauseState } from "../../dto/sync-access";

export interface SyncPauseReader {
	readSyncPause(vaultId: string): Promise<SyncPauseState | null>;
}
