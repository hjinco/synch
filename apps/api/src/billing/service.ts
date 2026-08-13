import { apiError, logServerError } from "../errors";
import {
	createPolarCheckout,
	createPolarCustomerPortalSession,
	updatePolarSubscriptionProduct,
	type PolarClientConfig,
} from "./polar";
import type { BillingRepository } from "./repository";
import type {
	PaidSubscriptionPlanId,
	SubscriptionBillingInterval,
	SubscriptionPlanId,
	SubscriptionProductIdsByPlanId,
} from "../subscription/policy";
import { subscriptionAccess } from "../subscription/policy-service";

export type BillingServiceConfig = PolarClientConfig & {
	productIdsByPlanId?: SubscriptionProductIdsByPlanId;
	publicBaseUrl: string;
	wwwBaseUrl: string;
	onSubscriptionUpsert?: (organizationId: string) => Promise<void>;
};

type BillingStatus = {
	planId: SubscriptionPlanId;
	billingInterval: SubscriptionBillingInterval | null;
	active: boolean;
	status: string;
	cancelAtPeriodEnd: boolean;
	periodEnd: string | null;
	canManageBilling: boolean;
};

type OrganizationBillingStatus = Omit<BillingStatus, "canManageBilling">;

const CHECKOUT_PLAN_IDS = ["starter"] as const satisfies readonly PaidSubscriptionPlanId[];
const CHECKOUT_PLAN_ID_SET = new Set<SubscriptionPlanId>(CHECKOUT_PLAN_IDS);
const BILLING_MANAGER_ROLES = new Set(["owner", "admin"]);

// Polar only allows product updates on subscriptions that are still running;
// canceled/past-due subscriptions keep period access but cannot be changed.
const CHANGEABLE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);

export class BillingService {
	constructor(
		private readonly repository: BillingRepository,
		private readonly config: BillingServiceConfig,
	) {}

	async createCheckout(input: {
		userId: string;
		email: string;
		planId: SubscriptionPlanId;
		billingInterval?: SubscriptionBillingInterval;
	}): Promise<{ checkoutId: string; url: string }> {
		const billingInterval = input.billingInterval ?? "monthly";
		const organizationId = await this.repository.readDefaultOrganizationIdForUser(
			input.userId,
		);
		if (!organizationId) {
			throw apiError(400, "organization_required", "user has no organization");
		}

		if (!CHECKOUT_PLAN_ID_SET.has(input.planId)) {
			throw apiError(400, "plan_not_available", "plan is not available for checkout");
		}

		const planId = input.planId as PaidSubscriptionPlanId;
		const productId =
			this.config.productIdsByPlanId?.[planId]?.[billingInterval];
		if (!productId) {
			throw new Error(
				`Polar product ID is not configured for ${planId} ${billingInterval}`,
			);
		}

		const billingStatus = await this.readOrganizationBillingStatus(organizationId);
		if (billingStatus.active) {
			throw apiError(
				409,
				"subscription_already_active",
				"paid subscription is already active",
			);
		}

		return await createPolarCheckout(this.config, {
			planId,
			billingInterval,
			productId,
			organizationId,
			userId: input.userId,
			email: input.email,
		});
	}

	async changeSubscriptionPlan(input: {
		userId: string;
		planId: SubscriptionPlanId;
		billingInterval: SubscriptionBillingInterval;
	}): Promise<BillingStatus> {
		const organizationId = await this.repository.readDefaultOrganizationIdForUser(
			input.userId,
		);
		if (!organizationId) {
			throw apiError(400, "organization_required", "user has no organization");
		}
		const organizationRole =
			await this.repository.readOrganizationRoleForUser(input.userId, organizationId);
		if (!organizationRole || !BILLING_MANAGER_ROLES.has(organizationRole)) {
			throw apiError(
				403,
				"billing_permission_required",
				"organization billing permission is required",
			);
		}

		if (!CHECKOUT_PLAN_ID_SET.has(input.planId)) {
			throw apiError(400, "plan_not_available", "plan is not available for checkout");
		}

		const planId = input.planId as PaidSubscriptionPlanId;
		const productId =
			this.config.productIdsByPlanId?.[planId]?.[input.billingInterval];
		if (!productId) {
			throw new Error(
				`Polar product ID is not configured for ${planId} ${input.billingInterval}`,
			);
		}

		const subscriptions =
			await this.repository.readOrganizationSubscriptionStatuses(organizationId);
		const current = subscriptions
			.map((subscription) => ({
				subscription,
				access: subscriptionAccess(subscription, {
					productIdsByPlanId: this.config.productIdsByPlanId,
				}),
			}))
			.find(({ subscription, access }) =>
				access !== null
				&& CHANGEABLE_SUBSCRIPTION_STATUSES.has(subscription.status)
			);
		if (!current) {
			throw apiError(
				409,
				"subscription_not_active",
				"no active subscription to change",
			);
		}
		if (current.subscription.productId === productId) {
			throw apiError(
				409,
				"subscription_plan_unchanged",
				"subscription already uses the requested plan",
			);
		}
		// Annual subscriptions cannot move back to monthly billing; the shorter
		// interval only becomes available again after the subscription ends.
		if (
			current.access?.billingInterval === "annual"
			&& input.billingInterval === "monthly"
		) {
			throw apiError(
				409,
				"billing_interval_downgrade_not_allowed",
				"switching from annual to monthly billing is not available",
			);
		}

		const updatedSubscription = await updatePolarSubscriptionProduct(this.config, {
			organizationId,
			polarSubscriptionId: current.subscription.polarSubscriptionId,
			productId,
		});
		// Persist the change right away so the caller sees the new plan without
		// waiting for the subscription webhook, which stays as an idempotent backup.
		await this.repository.upsertPolarSubscription(updatedSubscription);
		try {
			await this.config.onSubscriptionUpsert?.(updatedSubscription.organizationId);
		} catch (error) {
			// Polar and the local subscription record are already updated. The
			// webhook remains responsible for retrying this policy refresh.
			logServerError("billing subscription policy refresh", error);
		}

		return {
			...await this.readOrganizationBillingStatus(organizationId),
			canManageBilling: true,
		};
	}

	async readBillingStatus(userId: string): Promise<BillingStatus> {
		const organizationId = await this.repository.readDefaultOrganizationIdForUser(userId);
		if (!organizationId) {
			throw apiError(400, "organization_required", "user has no organization");
		}

		const organizationRole =
			await this.repository.readOrganizationRoleForUser(userId, organizationId);
		return {
			...await this.readOrganizationBillingStatus(organizationId),
			canManageBilling:
				organizationRole !== null && BILLING_MANAGER_ROLES.has(organizationRole),
		};
	}

	async createCustomerPortalSession(
		userId: string,
		returnPath = "/billing",
	): Promise<{ url: string }> {
		const organizationId = await this.repository.readDefaultOrganizationIdForUser(userId);
		if (!organizationId) {
			throw apiError(400, "organization_required", "user has no organization");
		}
		const organizationRole =
			await this.repository.readOrganizationRoleForUser(userId, organizationId);
		if (!organizationRole || !BILLING_MANAGER_ROLES.has(organizationRole)) {
			throw apiError(
				403,
				"billing_permission_required",
				"organization billing permission is required",
			);
		}

		const polarCustomerId =
			await this.repository.readOrganizationPolarCustomerId(organizationId);
		if (!polarCustomerId) {
			throw apiError(
				404,
				"billing_customer_not_found",
				"billing customer was not found",
			);
		}

		return await createPolarCustomerPortalSession(this.config, {
			polarCustomerId,
			returnUrl: new URL(returnPath, this.config.wwwBaseUrl).toString(),
		});
	}

	private async readOrganizationBillingStatus(
		organizationId: string,
	): Promise<OrganizationBillingStatus> {
		const subscriptions =
			await this.repository.readOrganizationSubscriptionStatuses(organizationId);
		const activeSubscription = subscriptions
			.map((subscription) => ({
				subscription,
				access: subscriptionAccess(subscription, {
					productIdsByPlanId: this.config.productIdsByPlanId,
				}),
			}))
			.find(({ access }) => access !== null);
		const active = activeSubscription !== undefined;
		const planId: SubscriptionPlanId = activeSubscription?.access?.planId ?? "free";
		return {
			planId,
			billingInterval: activeSubscription?.access?.billingInterval ?? null,
			active,
			status:
				activeSubscription?.subscription.status ?? subscriptions[0]?.status ?? "none",
			cancelAtPeriodEnd:
				activeSubscription?.subscription.cancelAtPeriodEnd
				?? subscriptions[0]?.cancelAtPeriodEnd
				?? false,
			periodEnd:
				(activeSubscription?.subscription.periodEnd ?? subscriptions[0]?.periodEnd)
					?.toISOString() ?? null,
		};
	}
}
