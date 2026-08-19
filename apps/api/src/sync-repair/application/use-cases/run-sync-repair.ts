import type { RunSyncRepair } from "../ports/inbound/run-sync-repair";
import type { CoordinatorRepairPort } from "../ports/outbound/coordinator-repair-port";
import type { SyncRepairResult } from "../dto/sync-repair";

export class RunSyncRepairUseCase implements RunSyncRepair {
	constructor(private readonly coordinatorRepairPort: CoordinatorRepairPort) {}

	async runSyncRepair(vaultId: string): Promise<SyncRepairResult> {
		return await this.coordinatorRepairPort.repairSyncState(vaultId);
	}
}
