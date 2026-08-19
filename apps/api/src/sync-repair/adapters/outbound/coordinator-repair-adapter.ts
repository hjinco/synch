import type { CoordinatorRepairPort } from "../../application/ports/outbound/coordinator-repair-port";
import type { SyncRepairResult } from "../../application/dto/sync-repair";

type CoordinatorStub = {
	fetch(request: Request): Promise<Response>;
};

export type CoordinatorNamespace = {
	getByName(name: string): CoordinatorStub;
};

export class CoordinatorRepairAdapter implements CoordinatorRepairPort {
	constructor(private readonly namespace: CoordinatorNamespace) {}

	async repairSyncState(vaultId: string): Promise<SyncRepairResult> {
		const response = await this.namespace.getByName(vaultId).fetch(
			new Request(
				`https://internal/internal/v1/vaults/${encodeURIComponent(vaultId)}/sync-repair`,
				{ method: "POST" },
			),
		);
		if (!response.ok) {
			throw new Error(`failed to repair sync state for vault ${vaultId}: ${response.status}`);
		}
		return (await response.json()) as SyncRepairResult;
	}
}
