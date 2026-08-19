export interface OrganizationVaultReader {
	listActiveVaultIdsForOrganization(organizationId: string): Promise<string[]>;
}
