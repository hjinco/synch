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
		organizationId?: string;
		email: string;
		planId: SubscriptionPlanId;
		billingInterval?: SubscriptionBillingInterval;
	}): Promise<CheckoutResult>;
	changeSubscriptionPlan(input: {
		userId: string;
		organizationId?: string;
		planId: SubscriptionPlanId;
		billingInterval: SubscriptionBillingInterval;
	}): Promise<BillingStatus>;
	readBillingStatus(userId: string, selectedOrganizationId?: string): Promise<BillingStatus>;
	createCustomerPortalSession(
		userId: string,
		returnPath?: string,
		selectedOrganizationId?: string,
	): Promise<CustomerPortalResult>;
}
