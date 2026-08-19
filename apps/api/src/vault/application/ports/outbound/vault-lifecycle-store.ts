import type { InactiveVaultCandidate } from "../../dto/vault-types";

export interface VaultLifecycleStore {
	markVaultDeletionQueued(vaultId: string): Promise<boolean>;
	markVaultDeletionQueueFailed(vaultId: string, message: string): Promise<void>;
	listInactiveVaultCandidates(
		inactiveSince: number,
		afterVaultId: string | null,
		limit: number,
	): Promise<InactiveVaultCandidate[]>;
	markVaultPurgeRunning(vaultId: string): Promise<void>;
	markVaultPurgeFailed(vaultId: string, message: string): Promise<void>;
	hardDeleteVault(vaultId: string): Promise<void>;
}
