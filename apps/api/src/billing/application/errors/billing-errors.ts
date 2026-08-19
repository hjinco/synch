export type BillingApplicationErrorCode =
	| "organization_required"
	| "plan_not_available"
	| "subscription_already_active"
	| "billing_permission_required"
	| "subscription_not_active"
	| "subscription_plan_unchanged"
	| "billing_interval_downgrade_not_allowed"
	| "billing_customer_not_found"
	| "subscription_canceled"
	| "payment_failed"
	| "subscription_locked";

export class BillingApplicationError extends Error {
	readonly name = "BillingApplicationError";

	constructor(
		readonly code: BillingApplicationErrorCode,
		readonly details: Record<string, unknown> = {},
	) {
		super(code);
	}
}
