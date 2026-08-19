import type { VaultOrganizationReader } from "../ports/inbound/vault-organization-reader";
import type { VaultCatalogStore } from "../ports/outbound/vault-catalog-store";

export class ReadVaultOrganizationUseCase implements VaultOrganizationReader {
	constructor(private readonly store: VaultCatalogStore) {}

	async listActiveVaultIdsForOrganization(organizationId: string): Promise<string[]> {
		return await this.store.listActiveVaultIdsForOrganization(organizationId);
	}

	async readVaultOrganizationId(vaultId: string): Promise<string | null> {
		return await this.store.readVaultOrganizationId(vaultId);
	}
}
