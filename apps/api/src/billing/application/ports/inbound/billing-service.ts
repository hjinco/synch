import type {
	BillingStatus,
	CheckoutResult,
	CustomerPortalResult,
} from "../../dto/billing";
import type {
	SubscriptionBillingInterval,
	SubscriptionPlanId,
} from "../../../../subscription/application";

export interface BillingService {
	createCheckout(input: {
		userId: string;
		email: string;
		planId: SubscriptionPlanId;
		billingInterval?: SubscriptionBillingInterval;
	}): Promise<CheckoutResult>;
	changeSubscriptionPlan(input: {
		userId: string;
		planId: SubscriptionPlanId;
		billingInterval: SubscriptionBillingInterval;
	}): Promise<BillingStatus>;
	readBillingStatus(userId: string): Promise<BillingStatus>;
	createCustomerPortalSession(
		userId: string,
		returnPath?: string,
	): Promise<CustomerPortalResult>;
}
