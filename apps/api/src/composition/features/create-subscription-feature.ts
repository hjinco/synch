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
import { SubscriptionService } from "../../subscription/application/services/subscription-service";
import type { AppDb } from "../../db/client";

export type SubscriptionFeatureConfig = {
	selfHosted: boolean;
	productIdsByPlanId?: SubscriptionProductIdsByPlanId;
};

export type SubscriptionRefreshDependencies = {
	vaultReader: OrganizationVaultReader;
	vaultPolicyTransport: VaultPolicyTransport;
};

export type SubscriptionFeature = {
	service: SubscriptionService;
	policyReader: SubscriptionPolicyReader;
	accessReader: SubscriptionAccessReader;
};

export type SubscriptionRefreshFeature = {
	refreshOrganizationPolicy: RefreshOrganizationPolicy;
	consumer: SubscriptionPolicyRefreshConsumer;
};

/** Creates the subscription application graph and its persistence adapter. */
export function createSubscriptionFeature(
	db: AppDb,
	config: SubscriptionFeatureConfig,
	refresh?: SubscriptionRefreshDependencies,
): SubscriptionFeature {
	const service = new SubscriptionService({
		selfHosted: config.selfHosted,
		productIdsByPlanId: config.productIdsByPlanId,
		dataReader: new DrizzleSubscriptionPolicyDataReader(db),
		...(refresh && {
			vaultReader: refresh.vaultReader,
			vaultPolicyWriter: new CoordinatorVaultPolicyWriter(
				refresh.vaultPolicyTransport,
			),
		}),
	});
	return {
		service,
		policyReader: service,
		accessReader: service,
	};
}

/** Creates the policy refresh service and its queue inbound adapter. */
export function createSubscriptionRefreshFeature(
	config: SubscriptionFeatureConfig & SubscriptionRefreshDependencies & {
		db: AppDb;
	},
): SubscriptionRefreshFeature {
	const { service } = createSubscriptionFeature(config.db, config, {
		vaultReader: config.vaultReader,
		vaultPolicyTransport: config.vaultPolicyTransport,
	});

	return {
		refreshOrganizationPolicy: service,
		consumer: new SubscriptionPolicyRefreshConsumer(service),
	};
}

/** Binds the Cloudflare queue resource to the subscription outbound port. */
export function createSubscriptionPolicyRefreshQueue(
	queue: Queue<SubscriptionPolicyRefreshMessage>,
): SubscriptionPolicyRefreshQueue {
	return new CloudflareSubscriptionPolicyRefreshQueue(queue);
}
