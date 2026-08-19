import type { SubscriptionPolicyRefreshMessage } from "../../dto/subscription-policy-refresh-message";

export interface SubscriptionPolicyRefreshQueue {
	enqueueOrganizationPolicyRefresh(organizationId: string): Promise<void>;
}

export type { SubscriptionPolicyRefreshMessage };
