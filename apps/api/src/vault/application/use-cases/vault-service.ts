import type { SubscriptionPolicyReader } from "../../../subscription/application";
import {
	canAccessVault,
	canGrantVaultAccess,
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
	): Promise<VaultRecord> {
		const organizationId = await this.catalogStore.readDefaultOrganizationIdForUser(userId);
		if (!organizationId) {
			throw new VaultApplicationError("organization_required");
		}

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
		if (!(await this.userCanManageVault(userId, vaultId))) {
			throw new VaultApplicationError("forbidden");
		}

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

	async grantVaultAccess(
		requesterUserId: string,
		vaultId: string,
		input: {
			userId: string;
			role: "admin" | "member";
			memberWrapper: VaultKeyWrapperInput & { kind: "member" };
		},
	): Promise<VaultKeyWrapperRecord> {
		const authorizationFacts =
			await this.authorizationStore.readVaultAuthorizationFacts(
				requesterUserId,
				vaultId,
			);
		if (!canGrantVaultAccess(authorizationFacts)) {
			throw new VaultApplicationError("forbidden");
		}

		const organizationId = await this.catalogStore.readVaultOrganizationId(vaultId);
		if (!organizationId) {
			throw new VaultApplicationError("not_found");
		}

		if (
			!(await this.authorizationStore.userIsOrganizationMember(input.userId, organizationId))
		) {
			throw new VaultApplicationError("not_organization_member");
		}

		return await this.keyStore.addVaultMember(
			vaultId,
			input.userId,
			input.role,
			input.memberWrapper,
		);
	}

}
