export interface BillingAccountStore {
	readDefaultOrganizationIdForUser(userId: string): Promise<string | null>;
	readOrganizationRoleForUser(
		userId: string,
		organizationId: string,
	): Promise<string | null>;
	readOrganizationPolarCustomerId(organizationId: string): Promise<string | null>;
}
