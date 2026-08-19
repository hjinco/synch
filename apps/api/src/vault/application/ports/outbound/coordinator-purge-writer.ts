export interface CoordinatorPurgeWriter {
	purgeVault(vaultId: string): Promise<void>;
}
