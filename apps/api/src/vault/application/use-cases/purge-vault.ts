import type { CoordinatorPurgeWriter } from "../ports/outbound/coordinator-purge-writer";
import type { VaultLifecycleStore } from "../ports/outbound/vault-lifecycle-store";
import type { PurgeVault } from "../ports/inbound/purge-vault";

export class PurgeVaultUseCase implements PurgeVault {
	constructor(
		private readonly store: VaultLifecycleStore,
		private readonly coordinator: CoordinatorPurgeWriter,
	) {}

	async purgeVault(vaultId: string): Promise<void> {
		await this.store.markVaultPurgeRunning(vaultId);
		try {
			await this.coordinator.purgeVault(vaultId);
			await this.store.hardDeleteVault(vaultId);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.store.markVaultPurgeFailed(vaultId, message);
			throw error;
		}
	}
}
