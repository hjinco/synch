import { polar, webhooks } from "@polar-sh/better-auth";
import { Polar } from "@polar-sh/sdk";
import type { Subscription } from "@polar-sh/sdk/models/components/subscription";
import type { BetterAuthPlugin } from "better-auth";

import type { BillingProviderConfig } from "../../../application/dto/billing";
import type { BillingSubscriptionStore } from "../../../application/ports/outbound/billing-subscription-store";
import {
	organizationIdFromPolarSubscription,
	toPolarSubscriptionUpsertInput,
} from "../../outbound/polar-provider";

export function createPolarWebhookPlugin(
	config: BillingProviderConfig,
	store: BillingSubscriptionStore,
): BetterAuthPlugin | null {
	if (!config.accessToken || !config.webhookSecret) {
		return null;
	}

	const client = new Polar({
		accessToken: config.accessToken,
		server: config.sandbox ? "sandbox" : "production",
	});
	const handleSubscription = async (payload: { data: Subscription }) => {
		const organizationId = organizationIdFromPolarSubscription(payload.data);
		if (!organizationId) {
			return;
		}
		await store.upsertPolarSubscription(
			toPolarSubscriptionUpsertInput(payload.data, organizationId),
		);
		await config.onSubscriptionUpsert?.(organizationId);
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
