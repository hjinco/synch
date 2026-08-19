import type { BetterAuthPlugin } from "better-auth";

import type { AppDb } from "../../db/client";
import type { BillingApplicationConfig, BillingService } from "../../billing/application";
import type {
	SubscriptionAccessReader,
	SubscriptionProductIdsByPlanId,
} from "../../subscription/application";
import { BillingApplicationService } from "../../billing/application/use-cases/billing-service";
import { DrizzleBillingStore } from "../../billing/adapters/outbound/drizzle-billing-store";
import { PolarBillingProvider } from "../../billing/adapters/outbound/polar-provider";
import { createPolarWebhookPlugin } from "../../billing/adapters/inbound/better-auth/polar-webhook-plugin";

export type BillingFeature = {
	service?: BillingService;
	authPlugin: BetterAuthPlugin | null;
};

export function createBillingFeature(config: {
	db: AppDb;
	enabled: boolean;
	billing?: BillingApplicationConfig;
	productIdsByPlanId?: SubscriptionProductIdsByPlanId;
	subscriptionAccessReader: SubscriptionAccessReader;
}): BillingFeature {
	if (!config.enabled) {
		return { authPlugin: null };
	}
	if (!config.billing) {
		throw new Error("billing configuration is required for the managed edition");
	}

	const billingConfig = {
		...config.billing,
		productIdsByPlanId: config.productIdsByPlanId,
	};
	const store = new DrizzleBillingStore(config.db);
	const provider = new PolarBillingProvider(billingConfig);
	return {
		service: new BillingApplicationService(
			store,
			store,
			provider,
			config.subscriptionAccessReader,
			billingConfig,
		),
		authPlugin: createPolarWebhookPlugin(billingConfig, store),
	};
}
