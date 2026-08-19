import type { VaultInactivityNotice } from "../../../domain/types";

export interface VaultPurgeQueue {
	enqueueVaultPurge(vaultId: string): Promise<void>;
	enqueueInactiveVaultPurge(input: {
		vaultId: string;
		notice: VaultInactivityNotice;
	}): Promise<void>;
}
