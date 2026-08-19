import type { SyncPauseReader } from "../../application/ports/outbound/sync-pause-reader";
import type { SyncPauseState } from "../../application/dto/sync-access";

type CoordinatorStub = {
	fetch(request: Request): Promise<Response>;
};

export type CoordinatorNamespace = {
	getByName(name: string): CoordinatorStub;
};

export class CoordinatorSyncPauseReader implements SyncPauseReader {
	constructor(private readonly namespace: CoordinatorNamespace) {}

	async readSyncPause(vaultId: string): Promise<SyncPauseState | null> {
		const response = await this.namespace.getByName(vaultId).fetch(
			new Request(
				`https://internal/internal/v1/vaults/${encodeURIComponent(vaultId)}/sync-state`,
			),
		);
		if (!response.ok) {
			throw new Error(`failed to read sync state for vault ${vaultId}: ${response.status}`);
		}

		const body = (await response.json()) as { syncPause: SyncPauseState | null };
		return body.syncPause;
	}
}
