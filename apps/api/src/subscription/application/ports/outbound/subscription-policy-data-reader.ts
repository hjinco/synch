import type { SubscriptionPolicyData } from "../../dto/subscription-policy-data";

export interface SubscriptionPolicyDataReader {
	readOrganizationPolicyData(
		organizationId: string,
	): Promise<SubscriptionPolicyData>;
}
