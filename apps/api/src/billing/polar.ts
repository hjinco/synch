import { polar, webhooks } from "@polar-sh/better-auth";
import { Polar } from "@polar-sh/sdk";
import type { Subscription } from "@polar-sh/sdk/models/components/subscription";
import { AlreadyCanceledSubscription } from "@polar-sh/sdk/models/errors/alreadycanceledsubscription";
import { PaymentFailed } from "@polar-sh/sdk/models/errors/paymentfailed";
import { SubscriptionLocked } from "@polar-sh/sdk/models/errors/subscriptionlocked";

import type {
	BillingRepository,
	PolarSubscriptionUpsertInput,
} from "./repository";
import { apiError } from "../errors";
import type {
	PaidSubscriptionPlanId,
	SubscriptionBillingInterval,
} from "../subscription/policy";

export type PolarClientConfig = {
	accessToken?: string;
	webhookSecret?: string;
	sandbox?: boolean;
};

export function createPolarAuthPlugin(
	config: PolarClientConfig & { publicBaseUrl: string },
	repository: BillingRepository,
	options: {
		onSubscriptionUpsert?: (organizationId: string) => Promise<void>;
	} = {},
) {
	if (!config.accessToken || !config.webhookSecret) {
		return null;
	}

	const client = createPolarClient(config);
	const handleSubscription = async (payload: {
		data: Subscription;
	}) => {
		const subscription = parsePolarSubscription(payload.data);
		if (subscription) {
			await repository.upsertPolarSubscription(subscription);
			await options.onSubscriptionUpsert?.(subscription.organizationId);
		}
	};

	return polar({
		client,
		use: [
			webhooks({
				secret: config.webhookSecret,
				onSubscriptionUpdated: handleSubscription,
			}),
		],
	});
}

export async function createPolarCheckout(
	config: PolarClientConfig & { wwwBaseUrl: string },
	input: {
		planId: PaidSubscriptionPlanId;
		billingInterval: SubscriptionBillingInterval;
		productId: string;
		organizationId: string;
		userId: string;
		email: string;
	},
): Promise<{ checkoutId: string; url: string }> {
	if (!config.accessToken) {
		throw new Error("POLAR_ACCESS_TOKEN is not configured");
	}
	const checkout = await createPolarClient(config).checkouts.create({
		products: [input.productId],
		externalCustomerId: input.userId,
		customerEmail: input.email,
		successUrl: new URL(
			"/billing/success?checkout_id={CHECKOUT_ID}",
			config.wwwBaseUrl,
		).toString(),
		metadata: {
			referenceId: input.organizationId,
			organizationId: input.organizationId,
			userId: input.userId,
			planId: input.planId,
			billingInterval: input.billingInterval,
		},
	});

	return {
		checkoutId: checkout.id,
		url: checkout.url,
	};
}

/**
 * Switches an existing Polar subscription to another product (plan or billing
 * interval). Proration is settled immediately ("invoice") so the customer is
 * charged or credited the difference at the time of the change instead of on
 * the next renewal.
 */
export async function updatePolarSubscriptionProduct(
	config: PolarClientConfig,
	input: {
		organizationId: string;
		polarSubscriptionId: string;
		productId: string;
	},
): Promise<PolarSubscriptionUpsertInput> {
	if (!config.accessToken) {
		throw new Error("POLAR_ACCESS_TOKEN is not configured");
	}

	let subscription: Subscription;
	try {
		subscription = await createPolarClient(config).subscriptions.update({
			id: input.polarSubscriptionId,
			subscriptionUpdate: {
				productId: input.productId,
				prorationBehavior: "invoice",
			},
		});
	} catch (error) {
		if (error instanceof AlreadyCanceledSubscription) {
			throw apiError(
				409,
				"subscription_canceled",
				"subscription is already canceled",
			);
		}
		if (error instanceof PaymentFailed) {
			throw apiError(402, "payment_failed", "payment for the plan change failed");
		}
		if (error instanceof SubscriptionLocked) {
			throw apiError(
				409,
				"subscription_locked",
				"subscription is already being updated",
			);
		}
		throw error;
	}

	return toPolarSubscriptionUpsertInput(subscription, input.organizationId);
}

export async function createPolarCustomerPortalSession(
	config: PolarClientConfig,
	input: {
		polarCustomerId: string;
		returnUrl: string;
	},
): Promise<{ url: string }> {
	if (!config.accessToken) {
		throw new Error("POLAR_ACCESS_TOKEN is not configured");
	}
	const session = await createPolarClient(config).customerSessions.create({
		customerId: input.polarCustomerId,
		returnUrl: input.returnUrl,
	});

	return {
		url: session.customerPortalUrl,
	};
}

function createPolarClient(config: PolarClientConfig): Polar {
	return new Polar({
		accessToken: config.accessToken,
		server: config.sandbox ? "sandbox" : "production",
	});
}

function parsePolarSubscription(
	subscription: Subscription,
): PolarSubscriptionUpsertInput | null {
	const organizationId = readString(subscription.metadata.referenceId)
		?? readString(subscription.metadata.organizationId);
	if (!organizationId) {
		return null;
	}

	return toPolarSubscriptionUpsertInput(subscription, organizationId);
}

function toPolarSubscriptionUpsertInput(
	subscription: Subscription,
	organizationId: string,
): PolarSubscriptionUpsertInput {
	return {
		id: `polar-sub-${subscription.id}`,
		productId: subscription.productId,
		organizationId,
		polarCustomerId: subscription.customerId,
		polarSubscriptionId: subscription.id,
		polarCheckoutId: subscription.checkoutId,
		status: subscription.status,
		periodStart: subscription.currentPeriodStart,
		periodEnd: subscription.currentPeriodEnd,
		cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
	};
}

function readString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value : null;
}
