import type {
	SubscriptionProductIdsByPlanId,
	SubscriptionAccessReader,
	SubscriptionPolicyReader,
} from "../../subscription/application";
import type { RefreshOrganizationPolicy } from "../../subscription/application/ports/inbound/refresh-organization-policy";
import type { OrganizationVaultReader } from "../../subscription/application/ports/outbound/organization-vault-reader";
import { DrizzleSubscriptionPolicyDataReader } from "../../subscription/adapters/outbound/drizzle-subscription-policy-data-reader";
import { SubscriptionPolicyRefreshConsumer } from "../../subscription/adapters/inbound/queue/subscription-policy-refresh-consumer";
import { CloudflareSubscriptionPolicyRefreshQueue } from "../../subscription/adapters/outbound/cloudflare-subscription-policy-refresh-queue";
import {
	CoordinatorVaultPolicyWriter,
	type VaultPolicyTransport,
} from "../../subscription/adapters/outbound/coordinator-vault-policy-writer";
import type { SubscriptionPolicyRefreshQueue } from "../../subscription/application/ports/outbound/subscription-policy-refresh-queue";
import type { SubscriptionPolicyRefreshMessage } from "../../subscription/application";
import { ReadSubscriptionAccessUseCase } from "../../subscription/application/use-cases/read-subscription-access";
import { ReadOrganizationPolicyUseCase } from "../../subscription/application/use-cases/read-organization-policy";
import { RefreshOrganizationPolicyUseCase } from "../../subscription/application/use-cases/refresh-organization-policy";
import type { AppDb } from "../../db/client";

export type SubscriptionFeatureConfig = {
	selfHosted: boolean;
	productIdsByPlanId?: SubscriptionProductIdsByPlanId;
};

export type SubscriptionFeature = {
	policyReader: SubscriptionPolicyReader;
	accessReader: SubscriptionAccessReader;
};

export type SubscriptionRefreshFeature = SubscriptionFeature & {
	refreshOrganizationPolicy: RefreshOrganizationPolicy;
	consumer: SubscriptionPolicyRefreshConsumer;
};

/** Creates the subscription application graph and its persistence adapter. */
export function createSubscriptionFeature(
	db: AppDb,
	config: SubscriptionFeatureConfig,
): SubscriptionFeature {
	const dataReader = new DrizzleSubscriptionPolicyDataReader(db);
	return {
		policyReader: new ReadOrganizationPolicyUseCase({
			selfHosted: config.selfHosted,
			productIdsByPlanId: config.productIdsByPlanId,
			dataReader,
		}),
		accessReader: new ReadSubscriptionAccessUseCase(),
	};
}

/** Creates the policy refresh use case and its queue inbound adapter. */
export function createSubscriptionRefreshFeature(
	config: SubscriptionFeatureConfig & {
		db: AppDb;
		vaultReader: OrganizationVaultReader;
		vaultPolicyTransport: VaultPolicyTransport;
	},
): SubscriptionRefreshFeature {
	const subscriptionFeature = createSubscriptionFeature(config.db, config);
	const refreshOrganizationPolicy = new RefreshOrganizationPolicyUseCase(
		subscriptionFeature.policyReader,
		config.vaultReader,
		new CoordinatorVaultPolicyWriter(config.vaultPolicyTransport),
	);

	return {
		...subscriptionFeature,
		refreshOrganizationPolicy,
		consumer: new SubscriptionPolicyRefreshConsumer(refreshOrganizationPolicy),
	};
}

/** Binds the Cloudflare queue resource to the subscription outbound port. */
export function createSubscriptionPolicyRefreshQueue(
	queue: Queue<SubscriptionPolicyRefreshMessage>,
): SubscriptionPolicyRefreshQueue {
	return new CloudflareSubscriptionPolicyRefreshQueue(queue);
}
