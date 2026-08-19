import { Polar } from "@polar-sh/sdk";
import type { Subscription } from "@polar-sh/sdk/models/components/subscription";
import { AlreadyCanceledSubscription } from "@polar-sh/sdk/models/errors/alreadycanceledsubscription";
import { PaymentFailed } from "@polar-sh/sdk/models/errors/paymentfailed";
import { SubscriptionLocked } from "@polar-sh/sdk/models/errors/subscriptionlocked";

import type {
	BillingProvider,
	} from "../../application/ports/outbound/billing-provider";
import type {
	BillingProviderConfig,
	PolarSubscriptionUpsertInput,
} from "../../application/dto/billing";
import { BillingApplicationError } from "../../application/errors/billing-errors";
import type {
	PaidSubscriptionPlanId,
	SubscriptionBillingInterval,
} from "../../../subscription/application";

export class PolarBillingProvider implements BillingProvider {
	constructor(private readonly config: BillingProviderConfig) {}

	async createCheckout(input: {
		planId: PaidSubscriptionPlanId;
		billingInterval: SubscriptionBillingInterval;
		productId: string;
		organizationId: string;
		userId: string;
		email: string;
	}): Promise<{ checkoutId: string; url: string }> {
		if (!this.config.accessToken) {
			throw new Error("POLAR_ACCESS_TOKEN is not configured");
		}
		const checkout = await this.client().checkouts.create({
			products: [input.productId],
			externalCustomerId: input.userId,
			customerEmail: input.email,
			successUrl: new URL(
				"/billing/success?checkout_id={CHECKOUT_ID}",
				this.config.wwwBaseUrl,
			).toString(),
			metadata: {
				referenceId: input.organizationId,
				organizationId: input.organizationId,
				userId: input.userId,
				planId: input.planId,
				billingInterval: input.billingInterval,
			},
		});
		return { checkoutId: checkout.id, url: checkout.url };
	}

	async updateSubscriptionProduct(input: {
		organizationId: string;
		polarSubscriptionId: string;
		productId: string;
	}): Promise<PolarSubscriptionUpsertInput> {
		if (!this.config.accessToken) {
			throw new Error("POLAR_ACCESS_TOKEN is not configured");
		}

		let subscription: Subscription;
		try {
			subscription = await this.client().subscriptions.update({
				id: input.polarSubscriptionId,
				subscriptionUpdate: {
					productId: input.productId,
					prorationBehavior: "invoice",
				},
			});
		} catch (error) {
			if (error instanceof AlreadyCanceledSubscription) {
				throw new BillingApplicationError("subscription_canceled");
			}
			if (error instanceof PaymentFailed) {
				throw new BillingApplicationError("payment_failed");
			}
			if (error instanceof SubscriptionLocked) {
				throw new BillingApplicationError("subscription_locked");
			}
			throw error;
		}

		return toPolarSubscriptionUpsertInput(subscription, input.organizationId);
	}

	async createCustomerPortalSession(input: {
		polarCustomerId: string;
		returnUrl: string;
	}): Promise<{ url: string }> {
		if (!this.config.accessToken) {
			throw new Error("POLAR_ACCESS_TOKEN is not configured");
		}
		const session = await this.client().customerSessions.create({
			customerId: input.polarCustomerId,
			returnUrl: input.returnUrl,
		});
		return { url: session.customerPortalUrl };
	}

	client(): Polar {
		if (!this.config.accessToken) {
			throw new Error("POLAR_ACCESS_TOKEN is not configured");
		}
		return new Polar({
			accessToken: this.config.accessToken,
			server: this.config.sandbox ? "sandbox" : "production",
		});
	}
}

// Adapter-level function exports keep provider tests focused on the wire
// mapping while the application depends on BillingProvider.
export type PolarClientConfig = Pick<
	BillingProviderConfig,
	"accessToken" | "sandbox"
> & { wwwBaseUrl?: string };

export function createPolarCheckout(
	config: PolarClientConfig,
	input: Parameters<BillingProvider["createCheckout"]>[0],
) {
	return new PolarBillingProvider({
		...config,
		publicBaseUrl: config.wwwBaseUrl ?? "https://synch.example",
		wwwBaseUrl: config.wwwBaseUrl ?? "https://synch.example",
	}).createCheckout(input);
}

export function updatePolarSubscriptionProduct(
	config: PolarClientConfig,
	input: Parameters<BillingProvider["updateSubscriptionProduct"]>[0],
) {
	return new PolarBillingProvider({
		...config,
		publicBaseUrl: config.wwwBaseUrl ?? "https://synch.example",
		wwwBaseUrl: config.wwwBaseUrl ?? "https://synch.example",
	}).updateSubscriptionProduct(input);
}

export function createPolarCustomerPortalSession(
	config: PolarClientConfig,
	input: Parameters<BillingProvider["createCustomerPortalSession"]>[0],
) {
	return new PolarBillingProvider({
		...config,
		publicBaseUrl: config.wwwBaseUrl ?? "https://synch.example",
		wwwBaseUrl: config.wwwBaseUrl ?? "https://synch.example",
	}).createCustomerPortalSession(input);
}

export function toPolarSubscriptionUpsertInput(
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

export function organizationIdFromPolarSubscription(
	subscription: Subscription,
): string | null {
	const referenceId = subscription.metadata.referenceId;
	const organizationId = subscription.metadata.organizationId;
	for (const value of [referenceId, organizationId]) {
		if (typeof value === "string" && value.trim()) {
			return value;
		}
	}
	return null;
}
