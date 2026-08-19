export interface VaultAuthorizationStore {
	userCanAccessVault(userId: string, vaultId: string): Promise<boolean>;
	userCanManageVault(userId: string, vaultId: string): Promise<boolean>;
	userCanGrantVaultAccess(userId: string, vaultId: string): Promise<boolean>;
	userIsOrganizationMember(userId: string, organizationId: string): Promise<boolean>;
}
