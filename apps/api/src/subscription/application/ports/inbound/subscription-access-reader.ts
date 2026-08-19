import type {
	SubscriptionAccess,
	SubscriptionAccessConfig,
	SubscriptionRecord,
} from "../../dto/subscription-policy";

export interface SubscriptionAccessReader {
	readSubscriptionAccess(
		subscription: SubscriptionRecord | undefined,
		config?: SubscriptionAccessConfig,
	): SubscriptionAccess | null;
}
