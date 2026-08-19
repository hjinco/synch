import { readPolarProductIdsByPlanId } from "../billing/adapters/outbound/product-ids";
import { readCloudflareProfile } from "../config/cloudflare";
import { isCommunityEdition } from "../config/deployment-profile";
import {
	createSubscriptionFeature,
	createSubscriptionRefreshFeature,
	type SubscriptionRefreshFeature,
} from "../composition/features/create-subscription-feature";
import {
	createVaultFeature,
	type VaultFeature,
} from "../composition/features/create-vault-feature";
import { createDb } from "../db/client";
import type { SubscriptionPolicyRefreshMessage } from "../subscription/application";
import { CoordinatorProxyRepository } from "../sync-coordinator/adapters/outbound/durable-object-rpc/coordinator-proxy-repository";
import type {
	VaultPurgeMessage,
	VaultRetentionEmailMessage,
} from "../vault/application";

export type QueueMessage =
	| VaultPurgeMessage
	| SubscriptionPolicyRefreshMessage
	| VaultRetentionEmailMessage;

export function createQueueConsumer(env: Env): QueueConsumer {
	const profile = readCloudflareProfile(env);
	const db = createDb(env.DB);
	const coordinatorProxyRepository = new CoordinatorProxyRepository(env.SYNC_COORDINATOR);
	const subscriptionFeature = createSubscriptionFeature(db, {
		selfHosted: isCommunityEdition(profile),
		productIdsByPlanId: readPolarProductIdsByPlanId(env),
	});
	const vaultFeature = createVaultFeature({
		db,
		policyReader: subscriptionFeature.policyReader,
		coordinatorPurgeTransport: coordinatorProxyRepository,
		retentionEmailQueue: env.RETENTION_NOTIFICATION_QUEUE as
			| Queue<VaultRetentionEmailMessage>
			| undefined,
		email: env.EMAIL,
		emailFrom: env.AUTH_EMAIL_FROM,
	});
	const subscriptionRefreshFeature = createSubscriptionRefreshFeature({
		db,
		selfHosted: isCommunityEdition(profile),
		productIdsByPlanId: readPolarProductIdsByPlanId(env),
		vaultReader: vaultFeature.organizationReader,
		vaultPolicyTransport: coordinatorProxyRepository,
	});
	return new QueueConsumer(
		vaultFeature.purgeConsumer,
		subscriptionRefreshFeature.consumer,
		vaultFeature.retentionEmailConsumer,
	);
}

export class QueueConsumer {
	constructor(
		private readonly vaultPurgeConsumer: VaultFeature["purgeConsumer"],
		private readonly policyRefreshConsumer: SubscriptionRefreshFeature["consumer"],
		private readonly retentionEmailConsumer: VaultFeature["retentionEmailConsumer"],
	) {}

	async handleBatch(batch: MessageBatch<QueueMessage>): Promise<void> {
		for (const message of batch.messages) {
			const type = message.body?.type;
			if (type === "vault_purge") {
				await this.vaultPurgeConsumer.handleMessage(
					message as Message<VaultPurgeMessage>,
				);
				continue;
			}
			if (type === "subscription_policy_refresh") {
				await this.policyRefreshConsumer.handleMessage(
					message as Message<SubscriptionPolicyRefreshMessage>,
				);
				continue;
			}
			if (type === "vault_retention_email") {
				await this.retentionEmailConsumer.handleMessage(
					message as Message<VaultRetentionEmailMessage>,
				);
				continue;
			}

			message.ack();
		}
	}
}

export type {
	SubscriptionPolicyRefreshMessage,
	VaultPurgeMessage,
	VaultRetentionEmailMessage,
};
