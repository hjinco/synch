import type {
	SubscriptionRecord,
	SubscriptionPlanLimitOverrides,
} from "../../domain/policy";

export type SubscriptionPolicyData = {
	subscriptions: SubscriptionRecord[];
	organization: SubscriptionPlanLimitOverrides | null;
};
