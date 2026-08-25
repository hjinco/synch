import type { VaultAuthorizationFacts } from "../../../domain/policy";

export type { VaultAuthorizationFacts } from "../../../domain/policy";

export interface VaultAuthorizationStore {
	readVaultAuthorizationFacts(
		userId: string,
		vaultId: string,
	): Promise<VaultAuthorizationFacts>;
	userIsOrganizationMember(userId: string, organizationId: string): Promise<boolean>;
}
