export const BILLING_CHECKOUT_PLAN_IDS = ["starter"] as const;

export type BillingCheckoutPlanId = (typeof BILLING_CHECKOUT_PLAN_IDS)[number];

export function isCheckoutPlanId(value: string): value is BillingCheckoutPlanId {
	return (BILLING_CHECKOUT_PLAN_IDS as readonly string[]).includes(value);
}

export function isBillingManagerRole(role: string | null): boolean {
	return role === "owner" || role === "admin";
}

export function isChangeableSubscriptionStatus(status: string): boolean {
	return status === "active" || status === "trialing";
}

export function isAnnualToMonthlyDowngrade(
	currentInterval: string | null | undefined,
	requestedInterval: string,
): boolean {
	return currentInterval === "annual" && requestedInterval === "monthly";
}
