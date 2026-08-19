import { logServerError } from "../../../errors";
import type {
	PaidSubscriptionPlanId,
	SubscriptionAccessReader,
	SubscriptionBillingInterval,
	SubscriptionPlanId,
} from "../../../subscription/application";
import {
	isAnnualToMonthlyDowngrade,
	isBillingManagerRole,
	isChangeableSubscriptionStatus,
	isCheckoutPlanId,
} from "../../domain/policy";
import type { BillingApplicationConfig } from "../dto/billing";
import { BillingApplicationError } from "../errors/billing-errors";
import type { BillingAccountStore } from "../ports/outbound/billing-account-store";
import type { BillingProvider } from "../ports/outbound/billing-provider";
import type { BillingSubscriptionStore } from "../ports/outbound/billing-subscription-store";
import type { BillingService as BillingServicePort } from "../ports/inbound/billing-service";

export type BillingServiceConfig = BillingApplicationConfig;

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

export class BillingApplicationService implements BillingServicePort {
	constructor(
		private readonly accountStore: BillingAccountStore,
		private readonly subscriptionStore: BillingSubscriptionStore,
		private readonly provider: BillingProvider,
		private readonly subscriptionAccessReader: SubscriptionAccessReader,
		private readonly config: BillingServiceConfig,
	) {}

	async createCheckout(input: {
		userId: string;
		email: string;
		planId: SubscriptionPlanId;
		billingInterval?: SubscriptionBillingInterval;
	}): Promise<{ checkoutId: string; url: string }> {
		const billingInterval = input.billingInterval ?? "monthly";
		const organizationId = await this.accountStore.readDefaultOrganizationIdForUser(
			input.userId,
		);
		if (!organizationId) {
			throw new BillingApplicationError("organization_required");
		}

		if (!isCheckoutPlanId(input.planId)) {
			throw new BillingApplicationError("plan_not_available");
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
			throw new BillingApplicationError("subscription_already_active");
		}

		return await this.provider.createCheckout({
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
		const organizationId = await this.accountStore.readDefaultOrganizationIdForUser(
			input.userId,
		);
		if (!organizationId) {
			throw new BillingApplicationError("organization_required");
		}
		const organizationRole =
			await this.accountStore.readOrganizationRoleForUser(input.userId, organizationId);
		if (!isBillingManagerRole(organizationRole)) {
			throw new BillingApplicationError("billing_permission_required");
		}

		if (!isCheckoutPlanId(input.planId)) {
			throw new BillingApplicationError("plan_not_available");
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
			await this.subscriptionStore.readOrganizationSubscriptionStatuses(organizationId);
		const current = subscriptions
			.map((subscription) => ({
				subscription,
				access: this.subscriptionAccessReader.readSubscriptionAccess(subscription, {
					productIdsByPlanId: this.config.productIdsByPlanId,
				}),
			}))
			.find(({ subscription, access }) =>
				access !== null
				&& isChangeableSubscriptionStatus(subscription.status)
			);
		if (!current) {
			throw new BillingApplicationError("subscription_not_active");
		}
		if (current.subscription.productId === productId) {
			throw new BillingApplicationError("subscription_plan_unchanged");
		}
		// Annual subscriptions cannot move back to monthly billing; the shorter
		// interval only becomes available again after the subscription ends.
		if (isAnnualToMonthlyDowngrade(current.access?.billingInterval, input.billingInterval)) {
			throw new BillingApplicationError("billing_interval_downgrade_not_allowed");
		}

		const updatedSubscription = await this.provider.updateSubscriptionProduct({
			organizationId,
			polarSubscriptionId: current.subscription.polarSubscriptionId,
			productId,
		});
		// Persist the change right away so the caller sees the new plan without
		// waiting for the subscription webhook, which stays as an idempotent backup.
		await this.subscriptionStore.upsertPolarSubscription(updatedSubscription);
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
		const organizationId = await this.accountStore.readDefaultOrganizationIdForUser(userId);
		if (!organizationId) {
			throw new BillingApplicationError("organization_required");
		}

		const organizationRole =
			await this.accountStore.readOrganizationRoleForUser(userId, organizationId);
		return {
			...await this.readOrganizationBillingStatus(organizationId),
			canManageBilling: isBillingManagerRole(organizationRole),
		};
	}

	async createCustomerPortalSession(
		userId: string,
		returnPath = "/billing",
	): Promise<{ url: string }> {
		const organizationId = await this.accountStore.readDefaultOrganizationIdForUser(userId);
		if (!organizationId) {
			throw new BillingApplicationError("organization_required");
		}
		const organizationRole =
			await this.accountStore.readOrganizationRoleForUser(userId, organizationId);
		if (!isBillingManagerRole(organizationRole)) {
			throw new BillingApplicationError("billing_permission_required");
		}

		const polarCustomerId =
			await this.accountStore.readOrganizationPolarCustomerId(organizationId);
		if (!polarCustomerId) {
			throw new BillingApplicationError("billing_customer_not_found");
		}

		return await this.provider.createCustomerPortalSession({
			polarCustomerId,
			returnUrl: new URL(returnPath, this.config.wwwBaseUrl).toString(),
		});
	}

	private async readOrganizationBillingStatus(
		organizationId: string,
	): Promise<OrganizationBillingStatus> {
		const subscriptions =
			await this.subscriptionStore.readOrganizationSubscriptionStatuses(organizationId);
		const activeSubscription = subscriptions
			.map((subscription) => ({
				subscription,
				access: this.subscriptionAccessReader.readSubscriptionAccess(subscription, {
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
