export interface AuthPersistence {
	readDefaultOrganizationIdForUser(userId: string): Promise<string | null>;
	setSessionActiveOrganization(
		sessionId: string,
		organizationId: string,
	): Promise<void>;
}
