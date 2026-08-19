import { describe, expect, it } from "vitest";

import {
	applySubscriptionPlanLimitOverrides,
	getSubscriptionPlanPolicy,
	subscriptionAccessPlanId,
	subscriptionBillingInterval,
	subscriptionGrantsAccess,
} from "./policy";

describe("subscription plan policies", () => {
	it("keeps plan limits when organization overrides are null", () => {
		const basePolicy = getSubscriptionPlanPolicy("free");

		expect(
			applySubscriptionPlanLimitOverrides(basePolicy, {
				syncedVaults: null,
			}),
		).toEqual(basePolicy);
	});

	it("allows zero-valued organization overrides", () => {
		const basePolicy = getSubscriptionPlanPolicy("free");

		expect(
			applySubscriptionPlanLimitOverrides(basePolicy, {
				syncedVaults: 0,
			}),
		).toEqual({
			...basePolicy,
			limits: { ...basePolicy.limits, syncedVaults: 0 },
		});
	});

	it("keeps period-scoped subscription access until the paid period ends", () => {
		const future = new Date(Date.now() + 60_000);
		const past = new Date(Date.now() - 60_000);

		expect(subscriptionGrantsAccess({ status: "canceled", periodEnd: future })).toBe(
			true,
		);
		expect(subscriptionGrantsAccess({ status: "past_due", periodEnd: future })).toBe(
			true,
		);
		expect(subscriptionGrantsAccess({ status: "unpaid", periodEnd: future })).toBe(
			true,
		);
		expect(subscriptionGrantsAccess({ status: "canceled", periodEnd: past })).toBe(
			false,
		);
		expect(subscriptionGrantsAccess({ status: "canceled", periodEnd: null })).toBe(
			false,
		);
	});

	it("maps subscriptions to plan ids and billing intervals through product ids", () => {
		const subscription = {
			productId: "starter-annual-product",
			status: "active",
			periodEnd: new Date(Date.now() + 60_000),
		};
		const config = {
			productIdsByPlanId: {
				starter: {
					monthly: "starter-monthly-product",
					annual: "starter-annual-product",
				},
			},
		};

		expect(subscriptionAccessPlanId(subscription, config)).toBe("starter");
		expect(subscriptionBillingInterval(subscription, config)).toBe("annual");
		expect(
			subscriptionAccessPlanId(
				{ ...subscription, productId: "other-product" },
				config,
			),
		).toBeNull();
	});
});
