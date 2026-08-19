import { subscriptionAccess } from "../../domain/policy";
import type {
	SubscriptionAccess,
	SubscriptionAccessConfig,
	SubscriptionRecord,
} from "../dto/subscription-policy";
import type { SubscriptionAccessReader } from "../ports/inbound/subscription-access-reader";

export class ReadSubscriptionAccessUseCase implements SubscriptionAccessReader {
	readSubscriptionAccess(
		subscription: SubscriptionRecord | undefined,
		config: SubscriptionAccessConfig = {},
	): SubscriptionAccess | null {
		return subscriptionAccess(subscription, config);
	}
}
