import {
	applySubscriptionPlanLimitOverrides,
	getSubscriptionPlanPolicy,
	subscriptionAccess,
	subscriptionAccessPlanId,
	type SubscriptionProductIdsByPlanId,
} from "../../domain/policy";
import type {
	SubscriptionAccess,
	SubscriptionAccessConfig,
	SubscriptionPlanPolicy,
	SubscriptionRecord,
} from "../dto/subscription-policy";
import type { RefreshOrganizationPolicy } from "../ports/inbound/refresh-organization-policy";
import type { SubscriptionAccessReader } from "../ports/inbound/subscription-access-reader";
import type { SubscriptionPolicyReader } from "../ports/inbound/subscription-policy-reader";
import type { OrganizationVaultReader } from "../ports/outbound/organization-vault-reader";
import type { SubscriptionPolicyDataReader } from "../ports/outbound/subscription-policy-data-reader";
import type { VaultPolicyWriter } from "../ports/outbound/vault-policy-writer";

export type SubscriptionServiceConfig = {
	selfHosted?: boolean;
	productIdsByPlanId?: SubscriptionProductIdsByPlanId;
	dataReader?: SubscriptionPolicyDataReader;
	vaultReader?: OrganizationVaultReader;
	vaultPolicyWriter?: VaultPolicyWriter;
};

export class SubscriptionService
	implements
		SubscriptionPolicyReader,
		SubscriptionAccessReader,
		RefreshOrganizationPolicy
{
	constructor(private readonly config: SubscriptionServiceConfig = {}) {}

	async readOrganizationPolicy(organizationId: string) {
		if (this.config.selfHosted) {
			return getSubscriptionPlanPolicy("self_hosted");
		}
		if (!this.config.dataReader) {
			return getSubscriptionPlanPolicy("free");
		}

		const data = await this.config.dataReader.readOrganizationPolicyData(organizationId);
		const activePlanId = data.subscriptions
			.map((subscription) =>
				subscriptionAccessPlanId(subscription, {
					productIdsByPlanId: this.config.productIdsByPlanId,
				}),
			)
			.find((planId) => planId !== null);
		const basePolicy = getSubscriptionPlanPolicy(activePlanId ?? "free");

		if (!data.organization) {
			return basePolicy;
		}

		return applySubscriptionPlanLimitOverrides(basePolicy, data.organization);
	}

	readSubscriptionAccess(
		subscription: SubscriptionRecord | undefined,
		config: SubscriptionAccessConfig = {},
	): SubscriptionAccess | null {
		return subscriptionAccess(subscription, config);
	}

	async refreshOrganizationPolicy(organizationId: string): Promise<void> {
		if (!this.config.vaultReader || !this.config.vaultPolicyWriter) {
			throw new Error("subscription policy refresh is not configured");
		}

		const policy = await this.readOrganizationPolicy(organizationId);
		const vaultIds =
			await this.config.vaultReader.listActiveVaultIdsForOrganization(organizationId);

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
		await this.config.vaultPolicyWriter?.applyVaultPolicy(vaultId, policy.limits);
	}
}
