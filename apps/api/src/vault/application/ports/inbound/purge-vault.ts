export interface PurgeVault {
	purgeVault(vaultId: string): Promise<void>;
}
