import type { SubscriptionPolicyReader } from "../../../subscription/application";
import {
	canAccessVault,
	canManageVault,
} from "../../domain/policy";
import type {
	VaultBootstrapRecord,
	VaultKeyEnvelope,
	VaultKeyWrapperInput,
	VaultKeyWrapperRecord,
	VaultPurgeResult,
	VaultRecord,
} from "../dto/vault-types";
import { VaultApplicationError } from "../errors/vault-errors";
import type { VaultService } from "../ports/inbound/vault-service";
import type { VaultAuthorizationStore } from "../ports/outbound/vault-authorization-store";
import type { VaultCatalogStore } from "../ports/outbound/vault-catalog-store";
import type { VaultKeyStore } from "../ports/outbound/vault-key-store";
import type { VaultLifecycleStore } from "../ports/outbound/vault-lifecycle-store";
import type { VaultPurgeQueue } from "../ports/outbound/vault-purge-queue";

export class VaultApplicationService implements VaultService {
	constructor(
		private readonly authorizationStore: VaultAuthorizationStore,
		private readonly catalogStore: VaultCatalogStore,
		private readonly keyStore: VaultKeyStore,
		private readonly lifecycleStore: VaultLifecycleStore,
		private readonly policyReader: SubscriptionPolicyReader,
		private readonly purgeQueue: VaultPurgeQueue,
		private readonly canCreateInOrganization?: (userId: string, organizationId: string) => Promise<boolean>,
	) {}

	async listVaults(
		userId: string,
		options: { includeDeleting?: boolean } = {},
	): Promise<VaultRecord[]> {
		return await this.catalogStore.listVaultsForUser(userId, options);
	}

	async createVault(
		userId: string,
		name: string,
		initialWrapper: VaultKeyWrapperInput,
		selectedOrganizationId?: string,
	): Promise<VaultRecord> {
		const organizationId = selectedOrganizationId ?? await this.catalogStore.readDefaultOrganizationIdForUser(userId);
		if (!organizationId) {
			throw new VaultApplicationError("organization_required");
		}

		if (this.canCreateInOrganization && !await this.canCreateInOrganization(userId, organizationId)) throw new VaultApplicationError("forbidden");
		const policy = await this.policyReader.readOrganizationPolicy(organizationId);
		const existingVaultCount =
			await this.catalogStore.countVaultsForOrganization(organizationId);
		if (
			policy.limits.syncedVaults > 0 &&
			existingVaultCount >= policy.limits.syncedVaults
		) {
			throw new VaultApplicationError("vault_limit_exceeded", {
				planName: policy.name,
				limit: policy.limits.syncedVaults,
			});
		}

		if (
			await this.catalogStore.vaultNameExistsForOrganization(
				organizationId,
				name,
			)
		) {
			throw new VaultApplicationError("vault_name_exists");
		}

		return await this.keyStore.createVaultForUser(
			userId,
			organizationId,
			name,
			initialWrapper,
            policy.limits.syncedVaults,
		);
	}

	async getVaultBootstrap(userId: string, vaultId: string): Promise<VaultBootstrapRecord> {
		const bootstrap = await this.catalogStore.readVaultBootstrapForUser(userId, vaultId);
		if (!bootstrap) {
			throw new VaultApplicationError("forbidden");
		}

		return bootstrap;
	}

	async replacePasswordWrapper(
		userId: string,
		vaultId: string,
		envelope: VaultKeyEnvelope,
	): Promise<VaultKeyWrapperRecord> {
		if (!(await this.userCanAccessVault(userId, vaultId))) {
			throw new VaultApplicationError("forbidden");
		}
		const vault = await this.catalogStore.readAccessibleVaultForUser(userId, vaultId);
		if (!vault || envelope.keyVersion !== vault.activeKeyVersion || (envelope.version === 2 && (envelope.binding?.userId !== userId || envelope.binding?.vaultId !== vaultId))) throw new VaultApplicationError("forbidden");

		return await this.keyStore.upsertPasswordWrapperForUser(
			userId,
			vaultId,
			envelope,
		);
	}

	async userCanAccessVault(userId: string, vaultId: string): Promise<boolean> {
		const facts = await this.authorizationStore.readVaultAuthorizationFacts(
			userId,
			vaultId,
		);
		return canAccessVault(facts);
	}

	async getAccessibleVault(userId: string, vaultId: string): Promise<VaultRecord | null> {
		return await this.catalogStore.readAccessibleVaultForUser(userId, vaultId);
	}

	async userCanManageVault(userId: string, vaultId: string): Promise<boolean> {
		const facts = await this.authorizationStore.readVaultAuthorizationFacts(
			userId,
			vaultId,
		);
		return canManageVault(facts);
	}

	async deleteVault(userId: string, vaultId: string): Promise<VaultPurgeResult> {
		if (!(await this.userCanManageVault(userId, vaultId))) {
			throw new VaultApplicationError("forbidden");
		}

		await this.lifecycleStore.markVaultDeletionQueued(vaultId);
		try {
			await this.purgeQueue.enqueueVaultPurge(vaultId);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.lifecycleStore.markVaultDeletionQueueFailed(vaultId, message);
			throw error;
		}

		return { vaultId, deletionStatus: "queued" };
	}

}
