import { describe, expect, it } from "vitest";

import type { AppDb } from "../db/client";
import {
	applySubscriptionPlanLimitOverrides,
	getSubscriptionPlanPolicy,
} from "./policy";
import {
	SubscriptionPolicyService,
	subscriptionGrantsAccess,
	subscriptionAccessPlanId,
	subscriptionBillingInterval,
} from "./policy-service";

describe("SubscriptionPolicyService", () => {
	it("uses the hosted free policy by default", async () => {
		const policy = await new SubscriptionPolicyService().readOrganizationPolicy("org-1");

		expect(policy).toEqual(getSubscriptionPlanPolicy("free"));
	});

	it("uses the self-hosted policy for self-hosted deployments", async () => {
		const policy = await new SubscriptionPolicyService(true).readOrganizationPolicy("org-1");

		expect(policy).toEqual(getSubscriptionPlanPolicy("self_hosted"));
	});

	it("uses the starter policy for a matching active product subscription", async () => {
		const policy = await new SubscriptionPolicyService(
			false,
			fakePolicyDb({
				organization: null,
				subscriptions: [
					{
						productId: "starter-annual-product",
						status: "active",
						periodEnd: new Date(Date.now() + 60_000),
					},
				],
			}),
			{
					productIdsByPlanId: {
						starter: {
							monthly: "starter-monthly-product",
							annual: "starter-annual-product",
						},
					},
			},
		).readOrganizationPolicy("org-1");

		expect(policy.id).toBe("starter");
	});

	it("ignores active subscriptions for unknown products", async () => {
		const policy = await new SubscriptionPolicyService(
			false,
			fakePolicyDb({
				organization: null,
				subscriptions: [
					{
						productId: "other-product",
						status: "active",
						periodEnd: new Date(Date.now() + 60_000),
					},
				],
			}),
			{
					productIdsByPlanId: {
						starter: {
							monthly: "starter-monthly-product",
							annual: "starter-annual-product",
						},
					},
			},
		).readOrganizationPolicy("org-1");

		expect(policy.id).toBe("free");
	});

	it("applies organization synced vault overrides on top of the plan policy", async () => {
		const policy = await new SubscriptionPolicyService(
			false,
			fakePolicyDb({
				organization: {
					syncedVaultsOverride: 3,
				},
				subscriptions: [],
			}),
		).readOrganizationPolicy("org-1");

		const basePolicy = getSubscriptionPlanPolicy("free");
		expect(policy).toEqual({
			...basePolicy,
			limits: { ...basePolicy.limits, syncedVaults: 3 },
		});
	});

	it("keeps plan limits when organization overrides are null", () => {
		const basePolicy = getSubscriptionPlanPolicy("free");
		const policy = applySubscriptionPlanLimitOverrides(basePolicy, {
			syncedVaults: null,
		});

		expect(policy).toEqual(basePolicy);
	});

	it("allows zero-valued organization overrides", () => {
		const basePolicy = getSubscriptionPlanPolicy("free");
		const policy = applySubscriptionPlanLimitOverrides(basePolicy, {
			syncedVaults: 0,
		});

		expect(policy).toEqual({
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
		expect(
			subscriptionAccessPlanId(
				{
					productId: "starter-annual-product",
					status: "active",
					periodEnd: new Date(Date.now() + 60_000),
				},
				{
					productIdsByPlanId: {
						starter: {
							monthly: "starter-monthly-product",
							annual: "starter-annual-product",
						},
					},
				},
			),
		).toBe("starter");
		expect(
			subscriptionBillingInterval(
				{
					productId: "starter-annual-product",
					status: "active",
					periodEnd: new Date(Date.now() + 60_000),
				},
				{
					productIdsByPlanId: {
						starter: {
							monthly: "starter-monthly-product",
							annual: "starter-annual-product",
						},
					},
				},
			),
		).toBe("annual");
		expect(
			subscriptionAccessPlanId(
				{
					productId: "other-product",
					status: "active",
					periodEnd: new Date(Date.now() + 60_000),
				},
				{
					productIdsByPlanId: {
						starter: {
							monthly: "starter-monthly-product",
							annual: "starter-annual-product",
						},
					},
				},
			),
		).toBeNull();
	});
});

function fakePolicyDb(input: {
	organization: {
		syncedVaultsOverride: number | null;
	} | null;
	subscriptions: Array<{
		productId?: string;
		status: string;
		periodEnd: Date | null;
	}>;
}): AppDb {
	return {
		select(_fields: Record<string, unknown>) {
			return {
				from() {
					return {
						where() {
							return {
								orderBy() {
									return {
										limit: async () => input.subscriptions,
									};
								},
								limit: async () =>
									input.organization ? [input.organization] : [],
							};
						},
					};
				},
			};
		},
	} as unknown as AppDb;
}
