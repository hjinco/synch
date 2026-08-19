import {
	BillingApplicationError,
	type BillingApplicationErrorCode,
} from "../../../application/errors/billing-errors";

export function mapBillingApplicationError(error: unknown): Response | undefined {
	if (!(error instanceof BillingApplicationError) && !isBillingErrorLike(error)) {
		return undefined;
	}
	const billingError = error as BillingApplicationError;
	return new Response(
		JSON.stringify({
			error: billingError.code,
			message: billingErrorMessage(billingError.code),
		}, null, 2),
		{
			status: billingErrorStatus(billingError.code),
			headers: { "content-type": "application/json; charset=utf-8" },
		},
	);
}

function isBillingErrorLike(error: unknown): error is BillingApplicationError {
	return (
		!!error &&
		typeof error === "object" &&
		(error as { name?: unknown }).name === "BillingApplicationError" &&
		typeof (error as { code?: unknown }).code === "string"
	);
}

function billingErrorStatus(code: BillingApplicationErrorCode): 400 | 402 | 403 | 404 | 409 {
	switch (code) {
		case "payment_failed":
			return 402;
		case "billing_permission_required":
			return 403;
		case "billing_customer_not_found":
			return 404;
		case "organization_required":
		case "plan_not_available":
			return 400;
		default:
			return 409;
	}
}

function billingErrorMessage(code: BillingApplicationErrorCode): string {
	switch (code) {
		case "organization_required":
			return "user has no organization";
		case "plan_not_available":
			return "plan is not available for checkout";
		case "subscription_already_active":
			return "paid subscription is already active";
		case "billing_permission_required":
			return "organization billing permission is required";
		case "subscription_not_active":
			return "no active subscription to change";
		case "subscription_plan_unchanged":
			return "subscription already uses the requested plan";
		case "billing_interval_downgrade_not_allowed":
			return "switching from annual to monthly billing is not available";
		case "billing_customer_not_found":
			return "billing customer was not found";
		case "subscription_canceled":
			return "subscription is already canceled";
		case "payment_failed":
			return "payment for the plan change failed";
		case "subscription_locked":
			return "subscription is already being updated";
	}
}
