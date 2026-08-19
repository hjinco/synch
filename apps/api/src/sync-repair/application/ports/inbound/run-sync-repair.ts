import type { SyncRepairResult } from "../../dto/sync-repair";

export interface RunSyncRepair {
	runSyncRepair(vaultId: string): Promise<SyncRepairResult>;
}
