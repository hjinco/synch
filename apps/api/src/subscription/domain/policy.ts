export const BYTES_PER_MB = 1_000_000;
export const BYTES_PER_GB = 1_000_000_000;

export const SUBSCRIPTION_PLAN_IDS = ["free", "starter", "self_hosted"] as const;
export const SUBSCRIPTION_BILLING_INTERVALS = ["monthly", "annual"] as const;

export type SubscriptionPlanId = (typeof SUBSCRIPTION_PLAN_IDS)[number];
export type PaidSubscriptionPlanId = Exclude<SubscriptionPlanId, "free" | "self_hosted">;
export type SubscriptionBillingInterval =
	(typeof SUBSCRIPTION_BILLING_INTERVALS)[number];
export type SubscriptionProductIdsByPlanId = Partial<
	Record<
		PaidSubscriptionPlanId,
		Partial<Record<SubscriptionBillingInterval, string>>
	>
>;

export type SubscriptionPlanPolicy = {
	id: SubscriptionPlanId;
	name: string;
	badge?: string;
	pricing: {
		monthlyUsd: number;
		annualMonthlyUsd: number;
		annualUsd: number;
	};
	limits: {
		syncedVaults: number;
		storageLimitBytes: number;
		maxFileSizeBytes: number;
		versionHistoryRetentionDays: number;
	};
	features: {
		snapshots: boolean;
		storageUpgrade: boolean;
	};
};

export type SubscriptionPlanLimitOverrides = {
	syncedVaults?: number | null;
};

export type SubscriptionRecord = {
	productId?: string;
	status: string;
	periodEnd: Date | null;
};

export type SubscriptionAccess = {
	planId: PaidSubscriptionPlanId;
	billingInterval: SubscriptionBillingInterval;
};

export const SUBSCRIPTION_PLAN_POLICIES = {
	free: {
		id: "free",
		name: "Sync Free",
		pricing: {
			monthlyUsd: 0,
			annualMonthlyUsd: 0,
			annualUsd: 0,
		},
		limits: {
			syncedVaults: 1,
			storageLimitBytes: 50 * BYTES_PER_MB,
			maxFileSizeBytes: 3 * BYTES_PER_MB,
			versionHistoryRetentionDays: 1,
		},
		features: {
			snapshots: true,
			storageUpgrade: false,
		},
	},
	starter: {
		id: "starter",
		name: "Sync Starter",
		badge: "$1/month",
		pricing: {
			monthlyUsd: 1,
			annualMonthlyUsd: 10 / 12,
			annualUsd: 10,
		},
		limits: {
			syncedVaults: 1,
			storageLimitBytes: BYTES_PER_GB,
			maxFileSizeBytes: 5 * BYTES_PER_MB,
			versionHistoryRetentionDays: 30,
		},
		features: {
			snapshots: true,
			storageUpgrade: false,
		},
	},
	self_hosted: {
		id: "self_hosted",
		name: "Self Hosted",
		pricing: {
			monthlyUsd: 0,
			annualMonthlyUsd: 0,
			annualUsd: 0,
		},
		limits: {
			syncedVaults: 0,
			storageLimitBytes: 0,
			maxFileSizeBytes: 0,
			versionHistoryRetentionDays: 1,
		},
		features: {
			snapshots: true,
			storageUpgrade: false,
		},
	},
} as const satisfies Record<SubscriptionPlanId, SubscriptionPlanPolicy>;

export function getSubscriptionPlanPolicy(
	planId: SubscriptionPlanId,
): SubscriptionPlanPolicy {
	return SUBSCRIPTION_PLAN_POLICIES[planId];
}

export function applySubscriptionPlanLimitOverrides(
	policy: SubscriptionPlanPolicy,
	overrides: SubscriptionPlanLimitOverrides,
): SubscriptionPlanPolicy {
	return {
		...policy,
		limits: {
			syncedVaults:
				overrides.syncedVaults ?? policy.limits.syncedVaults,
			storageLimitBytes: policy.limits.storageLimitBytes,
			maxFileSizeBytes: policy.limits.maxFileSizeBytes,
			versionHistoryRetentionDays: policy.limits.versionHistoryRetentionDays,
		},
	};
}

const ACTIVE_ACCESS_STATUSES = new Set(["active", "trialing"]);
const PERIOD_ACCESS_STATUSES = new Set(["canceled", "past_due", "unpaid"]);

export type SubscriptionAccessConfig = {
	productIdsByPlanId?: SubscriptionProductIdsByPlanId;
};

export function subscriptionGrantsAccess(
	subscription: SubscriptionRecord | undefined,
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
	subscription: SubscriptionRecord | undefined,
	config: SubscriptionAccessConfig = {},
): SubscriptionPlanId | null {
	return subscriptionAccess(subscription, config)?.planId ?? null;
}

export function subscriptionBillingInterval(
	subscription: SubscriptionRecord | undefined,
	config: SubscriptionAccessConfig = {},
): SubscriptionBillingInterval | null {
	return subscriptionAccess(subscription, config)?.billingInterval ?? null;
}

export function subscriptionAccess(
	subscription: SubscriptionRecord | undefined,
	config: SubscriptionAccessConfig = {},
): SubscriptionAccess | null {
	if (!subscription || !subscriptionGrantsAccess(subscription)) {
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
