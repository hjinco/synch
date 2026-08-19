import type { SyncRepairResult } from "../../dto/sync-repair";

export interface CoordinatorRepairPort {
	repairSyncState(vaultId: string): Promise<SyncRepairResult>;
}
