import {
	applySubscriptionPlanLimitOverrides,
	getSubscriptionPlanPolicy,
	subscriptionAccessPlanId,
	type SubscriptionProductIdsByPlanId,
} from "../../domain/policy";
import type { SubscriptionPolicyReader } from "../ports/inbound/subscription-policy-reader";
import type { SubscriptionPolicyDataReader } from "../ports/outbound/subscription-policy-data-reader";

export type ReadOrganizationPolicyUseCaseConfig = {
	selfHosted?: boolean;
	productIdsByPlanId?: SubscriptionProductIdsByPlanId;
	dataReader?: SubscriptionPolicyDataReader;
};

export class ReadOrganizationPolicyUseCase implements SubscriptionPolicyReader {
	constructor(private readonly config: ReadOrganizationPolicyUseCaseConfig = {}) {}

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
}
