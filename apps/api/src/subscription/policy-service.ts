import { desc, eq } from "drizzle-orm";

import type { AppDb } from "../db/client";
import * as schema from "../db/d1";
import {
	applySubscriptionPlanLimitOverrides,
	getSubscriptionPlanPolicy,
	type PaidSubscriptionPlanId,
	type SubscriptionBillingInterval,
	type SubscriptionPlanId,
	type SubscriptionPlanPolicy,
	type SubscriptionProductIdsByPlanId,
} from "./policy";

export type SubscriptionPolicyReader = {
	readOrganizationPolicy(organizationId: string): Promise<SubscriptionPlanPolicy>;
};

const ACTIVE_ACCESS_STATUSES = new Set(["active", "trialing"]);
const PERIOD_ACCESS_STATUSES = new Set(["canceled", "past_due", "unpaid"]);

export type SubscriptionPolicyServiceConfig = {
	productIdsByPlanId?: SubscriptionProductIdsByPlanId;
};

export class SubscriptionPolicyService implements SubscriptionPolicyReader {
	constructor(
		private readonly selfHosted = false,
		private readonly db: AppDb | null = null,
		private readonly config: SubscriptionPolicyServiceConfig = {},
	) {}

	async readOrganizationPolicy(organizationId: string): Promise<SubscriptionPlanPolicy> {
		if (this.selfHosted) {
			return getSubscriptionPlanPolicy("self_hosted");
		}
		if (!this.db) {
			return getSubscriptionPlanPolicy("free");
		}

		const subscriptions = await this.db
			.select({
				productId: schema.polarSubscription.productId,
				status: schema.polarSubscription.status,
				periodEnd: schema.polarSubscription.periodEnd,
			})
			.from(schema.polarSubscription)
			.where(eq(schema.polarSubscription.organizationId, organizationId))
			.orderBy(desc(schema.polarSubscription.periodEnd))
			.limit(10);

		const activePlanId = subscriptions
			.map((subscription) =>
				subscriptionAccess(subscription, {
					productIdsByPlanId: this.config.productIdsByPlanId,
				}),
			)
			.find((access) => access !== null)?.planId;
		const basePolicy = getSubscriptionPlanPolicy(activePlanId ?? "free");

		const organizations = await this.db
			.select({
				syncedVaultsOverride: schema.organization.syncedVaultsOverride,
			})
			.from(schema.organization)
			.where(eq(schema.organization.id, organizationId))
			.limit(1);

		const organization = organizations[0];
		if (!organization) {
			return basePolicy;
		}

		return applySubscriptionPlanLimitOverrides(basePolicy, {
			syncedVaults: organization.syncedVaultsOverride,
		});
	}

}

export function subscriptionGrantsAccess(
	subscription:
		| {
				productId?: string;
				status: string;
				periodEnd: Date | null;
		  }
		| undefined,
): boolean {
	if (!subscription) {
		return false;
	}
	if (ACTIVE_ACCESS_STATUSES.has(subscription.status)) {
		return !subscription.periodEnd || subscription.periodEnd.getTime() > Date.now();
	}
	if (!PERIOD_ACCESS_STATUSES.has(subscription.status)) {
		return false;
	}

	return !!subscription.periodEnd && subscription.periodEnd.getTime() > Date.now();
}

export function subscriptionAccessPlanId(
	subscription:
		| {
				productId?: string;
				status: string;
				periodEnd: Date | null;
		  }
		| undefined,
	config: SubscriptionPolicyServiceConfig = {},
): SubscriptionPlanId | null {
	return subscriptionAccess(subscription, config)?.planId ?? null;
}

export function subscriptionBillingInterval(
	subscription:
		| {
				productId?: string;
				status: string;
				periodEnd: Date | null;
		  }
		| undefined,
	config: SubscriptionPolicyServiceConfig = {},
): SubscriptionBillingInterval | null {
	return subscriptionAccess(subscription, config)?.billingInterval ?? null;
}

export function subscriptionAccess(
	subscription:
		| {
				productId?: string;
				status: string;
				periodEnd: Date | null;
		  }
		| undefined,
	config: SubscriptionPolicyServiceConfig = {},
): {
	planId: PaidSubscriptionPlanId;
	billingInterval: SubscriptionBillingInterval;
} | null {
	if (!subscription) {
		return null;
	}
	if (!subscriptionGrantsAccess(subscription)) {
		return null;
	}

	const productIdsByPlanId = config.productIdsByPlanId ?? {};
	for (const [planId, productIdsByInterval] of Object.entries(productIdsByPlanId)) {
		for (const [billingInterval, productId] of Object.entries(
			productIdsByInterval ?? {},
		)) {
			if (productId && subscription.productId === productId) {
				return {
					planId: planId as PaidSubscriptionPlanId,
					billingInterval: billingInterval as SubscriptionBillingInterval,
				};
			}
		}
	}

	return null;
}
