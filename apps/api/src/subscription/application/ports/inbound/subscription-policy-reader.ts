import type { SubscriptionPlanPolicy } from "../../dto/subscription-policy";

export interface SubscriptionPolicyReader {
	readOrganizationPolicy(organizationId: string): Promise<SubscriptionPlanPolicy>;
}
