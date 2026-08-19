import type {
	CheckoutResult,
	CustomerPortalResult,
	PolarSubscriptionUpsertInput,
} from "../../dto/billing";
import type {
	PaidSubscriptionPlanId,
	SubscriptionBillingInterval,
} from "../../../../subscription/application";

export interface BillingProvider {
	createCheckout(input: {
		planId: PaidSubscriptionPlanId;
		billingInterval: SubscriptionBillingInterval;
		productId: string;
		organizationId: string;
		userId: string;
		email: string;
	}): Promise<CheckoutResult>;
	updateSubscriptionProduct(input: {
		organizationId: string;
		polarSubscriptionId: string;
		productId: string;
	}): Promise<PolarSubscriptionUpsertInput>;
	createCustomerPortalSession(input: {
		polarCustomerId: string;
		returnUrl: string;
	}): Promise<CustomerPortalResult>;
}
