export interface VaultOrganizationReader {
	listActiveVaultIdsForOrganization(organizationId: string): Promise<string[]>;
	readVaultOrganizationId(vaultId: string): Promise<string | null>;
}
