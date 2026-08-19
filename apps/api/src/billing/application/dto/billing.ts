import type {
	SubscriptionBillingInterval,
	SubscriptionPlanId,
	SubscriptionProductIdsByPlanId,
} from "../../../subscription/application";

export type BillingProviderConfig = {
	accessToken?: string;
	webhookSecret?: string;
	sandbox?: boolean;
	publicBaseUrl: string;
	wwwBaseUrl: string;
	onSubscriptionUpsert?: (organizationId: string) => Promise<void>;
};

export type BillingApplicationConfig = BillingProviderConfig & {
	productIdsByPlanId?: SubscriptionProductIdsByPlanId;
};

export type OrganizationSubscriptionStatus = {
	productId: string;
	polarSubscriptionId: string;
	status: string;
	periodEnd: Date | null;
	cancelAtPeriodEnd: boolean;
	updatedAt: Date;
};

export type PolarSubscriptionUpsertInput = {
	id: string;
	productId: string;
	organizationId: string;
	polarCustomerId: string;
	polarSubscriptionId: string;
	polarCheckoutId: string | null;
	status: string;
	periodStart: Date | null;
	periodEnd: Date | null;
	cancelAtPeriodEnd: boolean;
};

export type BillingStatus = {
	planId: SubscriptionPlanId;
	billingInterval: SubscriptionBillingInterval | null;
	active: boolean;
	status: string;
	cancelAtPeriodEnd: boolean;
	periodEnd: string | null;
	canManageBilling: boolean;
};

export type CheckoutResult = { checkoutId: string; url: string };
export type CustomerPortalResult = { url: string };
