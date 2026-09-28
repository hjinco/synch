import { Polar } from "@polar-sh/sdk";
import type { Subscription } from "@polar-sh/sdk/models/components/subscription";
import { AlreadyCanceledSubscription } from "@polar-sh/sdk/models/errors/alreadycanceledsubscription";
import { PaymentFailed } from "@polar-sh/sdk/models/errors/paymentfailed";
import { SubscriptionLocked } from "@polar-sh/sdk/models/errors/subscriptionlocked";
import { ResourceNotFound } from "@polar-sh/sdk/models/errors/resourcenotfound";
import { HTTPValidationError } from "@polar-sh/sdk/models/errors/httpvalidationerror";

import type { BillingProvider } from "../../application/ports/outbound/billing-provider";
import type {
	BillingProviderConfig,
	PolarSubscriptionUpsertInput,
} from "../../application/dto/billing";
import { BillingApplicationError } from "../../application/errors/billing-errors";

export class PolarBillingProvider implements BillingProvider {
	constructor(private readonly config: BillingProviderConfig) {}

	async createCheckout(input: Parameters<BillingProvider["createCheckout"]>[0]): Promise<{ checkoutId: string; url: string }> {
		if (!this.config.accessToken) {
			throw new Error("POLAR_ACCESS_TOKEN is not configured");
		}
		const client = this.client();
		const customerId = await this.checkoutCustomerId(client, input);
		const checkout = await client.checkouts.create({
			products: [input.productId],
			customerId,
			successUrl: new URL(
				`/billing/success?checkout_id={CHECKOUT_ID}&organizationId=${encodeURIComponent(input.organizationId)}`,
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

	private async checkoutCustomerId(
		client: Polar,
		input: Parameters<BillingProvider["createCheckout"]>[0],
	): Promise<string> {
		// The persisted binding also preserves customers created before external
		// customer IDs changed from user IDs to organization IDs.
		if (input.polarCustomerId) return input.polarCustomerId;
		const existing = await this.findOrganizationCustomerId(client, input.organizationId);
		if (existing) return existing;

		// An unbound checkout falls back to email matching in Polar. Create the
		// customer first so a duplicate email fails before any checkout is opened.
		try {
			const customer = await client.customers.create({
				externalId: input.organizationId,
				email: input.email,
			});
			return customer.id;
		} catch (error) {
			if (!(error instanceof HTTPValidationError)) throw error;
			// Another request may have just created this same organization's customer.
			const concurrent = await this.findOrganizationCustomerId(client, input.organizationId);
			if (concurrent) return concurrent;
			if (error.detail?.some((detail) => detail.loc.join(".") === "body.email")) {
				throw new BillingApplicationError("billing_email_unavailable");
			}
			throw error;
		}
	}

	private async findOrganizationCustomerId(client: Polar, organizationId: string): Promise<string | null> {
		try {
			return (await client.customers.getExternal({ externalId: organizationId })).id;
		} catch (error) {
			if (error instanceof ResourceNotFound) return null;
			throw error;
		}
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
