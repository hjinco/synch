import type {
	VaultBootstrapRecord,
	VaultRecord,
} from "../../dto/vault-types";

export interface VaultCatalogStore {
	listVaultsForUser(
		userId: string,
		options?: { includeDeleting?: boolean },
	): Promise<VaultRecord[]>;
	readAccessibleVaultForUser(userId: string, vaultId: string): Promise<VaultRecord | null>;
	readVaultBootstrapForUser(userId: string, vaultId: string): Promise<VaultBootstrapRecord | null>;
	countVaultsForOrganization(organizationId: string): Promise<number>;
	listActiveVaultIdsForOrganization(organizationId: string): Promise<string[]>;
	readDefaultOrganizationIdForUser(userId: string): Promise<string | null>;
	vaultNameExistsForOrganization(organizationId: string, name: string): Promise<boolean>;
	readVaultOrganizationId(vaultId: string): Promise<string | null>;
}
