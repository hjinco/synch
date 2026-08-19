import type { SubscriptionPlanPolicy } from "../../application/dto/subscription-policy";
import type { VaultPolicyWriter } from "../../application/ports/outbound/vault-policy-writer";

export type VaultPolicyTransport = {
	applyVaultPolicy(
		vaultId: string,
		limits: SubscriptionPlanPolicy["limits"],
	): Promise<Response>;
};

export class CoordinatorVaultPolicyWriter implements VaultPolicyWriter {
	constructor(private readonly coordinator: VaultPolicyTransport) {}

	async applyVaultPolicy(
		vaultId: string,
		limits: SubscriptionPlanPolicy["limits"],
	): Promise<void> {
		const response = await this.coordinator.applyVaultPolicy(vaultId, limits);
		if (!response.ok) {
			throw new Error(
				`vault policy refresh failed for ${vaultId}: ${response.status}`,
			);
		}
	}
}
