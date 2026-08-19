import type { SubscriptionPlanPolicy } from "../dto/subscription-policy";
import type { OrganizationVaultReader } from "../ports/outbound/organization-vault-reader";
import type { VaultPolicyWriter } from "../ports/outbound/vault-policy-writer";
import type { RefreshOrganizationPolicy } from "../ports/inbound/refresh-organization-policy";
import type { SubscriptionPolicyReader } from "../ports/inbound/subscription-policy-reader";

export class RefreshOrganizationPolicyUseCase
	implements RefreshOrganizationPolicy
{
	constructor(
		private readonly policyReader: SubscriptionPolicyReader,
		private readonly vaultReader: OrganizationVaultReader,
		private readonly vaultPolicyWriter: VaultPolicyWriter,
	) {}

	async refreshOrganizationPolicy(organizationId: string): Promise<void> {
		const policy = await this.policyReader.readOrganizationPolicy(organizationId);
		const vaultIds =
			await this.vaultReader.listActiveVaultIdsForOrganization(organizationId);

		const results = await Promise.allSettled(
			vaultIds.map((vaultId) => this.applyVaultPolicy(vaultId, policy)),
		);
		const failures = results.filter((result) => result.status === "rejected");
		if (failures.length > 0) {
			throw new Error(`failed to refresh policy for ${failures.length} vault`);
		}
	}

	private async applyVaultPolicy(
		vaultId: string,
		policy: SubscriptionPlanPolicy,
	): Promise<void> {
		await this.vaultPolicyWriter.applyVaultPolicy(
			vaultId,
			policy.limits,
		);
	}
}
