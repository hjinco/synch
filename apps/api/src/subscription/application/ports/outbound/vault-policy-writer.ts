import type { SubscriptionPlanPolicy } from "../../dto/subscription-policy";

export interface VaultPolicyWriter {
	applyVaultPolicy(
		vaultId: string,
		limits: SubscriptionPlanPolicy["limits"],
	): Promise<void>;
}
