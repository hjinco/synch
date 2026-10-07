import { SyncAccessApplicationError } from "../../application/errors/sync-access-errors";
import type { SyncPauseResumer } from "../../application/ports/outbound/sync-pause-resumer";
import type { SyncPauseReader } from "../../application/ports/outbound/sync-pause-reader";
import type { SyncPauseState } from "../../application/dto/sync-access";

type CoordinatorStub = {
	fetch(request: Request): Promise<Response>;
};

export type CoordinatorNamespace = {
	getByName(name: string): CoordinatorStub;
};

export class CoordinatorSyncPauseReader implements SyncPauseReader, SyncPauseResumer {
	constructor(private readonly namespace: CoordinatorNamespace) {}

	async resumeSync(vaultId: string): Promise<void> {
		const response = await this.namespace.getByName(vaultId).fetch(new Request(
			`https://internal/internal/v1/vaults/${encodeURIComponent(vaultId)}/sync-resume`,
			{ method: "POST" },
		));
		if (response.status === 409) throw new SyncAccessApplicationError("sync_paused");
		if (!response.ok) throw new Error(`failed to resume sync: ${response.status}`);
	}

	async readSyncPause(vaultId: string): Promise<SyncPauseState | null> {
		const response = await this.namespace.getByName(vaultId).fetch(
			new Request(
				`https://internal/internal/v1/vaults/${encodeURIComponent(vaultId)}/sync-state`,
			),
		);
		if (!response.ok) {
			throw new Error(`failed to read sync state for vault ${vaultId}: ${response.status}`);
		}

		const body = await response.json<{ syncPause: SyncPauseState | null }>();
		return body.syncPause;
	}
}
