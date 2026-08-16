import { readPolarProductIdsByPlanId } from "../billing/product-ids";
import { readCloudflareProfile } from "../config/cloudflare";
import { isCommunityEdition } from "../config/deployment-profile";
import { createDb } from "../db/client";
import { SubscriptionPolicyRefreshConsumer } from "../subscription/policy-refresh-consumer";
import type { SubscriptionPolicyRefreshMessage } from "../subscription/policy-refresh-queue";
import { SubscriptionPolicyRefreshService } from "../subscription/policy-refresh-service";
import { SubscriptionPolicyService } from "../subscription/policy-service";
import { CoordinatorProxyRepository } from "../sync/coordinator/proxy-repository";
import { VaultPurgeConsumer } from "../vault/purge-consumer";
import type { VaultPurgeMessage } from "../vault/purge-queue";
import { VaultRetentionEmailConsumer } from "../vault/retention-email-consumer";
import {
	CloudflareVaultRetentionEmailQueue,
	type VaultRetentionEmailMessage,
} from "../vault/retention-queue";
import { VaultRepository } from "../vault/repository";
import { VaultService } from "../vault/service";

export type QueueMessage =
	| VaultPurgeMessage
	| SubscriptionPolicyRefreshMessage
	| VaultRetentionEmailMessage;

export function createQueueConsumer(env: Env): QueueConsumer {
	const profile = readCloudflareProfile(env);
	const db = createDb(env.DB);
	const vaultRepository = new VaultRepository(db);
	const subscriptionPolicyService = new SubscriptionPolicyService(
		isCommunityEdition(profile),
		db,
		{
			productIdsByPlanId: readPolarProductIdsByPlanId(env),
		},
	);
	const vaultService = new VaultService(vaultRepository, subscriptionPolicyService);
	const coordinatorProxyRepository = new CoordinatorProxyRepository(env.SYNC_COORDINATOR);
	const policyRefreshService = new SubscriptionPolicyRefreshService(
		subscriptionPolicyService,
		vaultRepository,
		coordinatorProxyRepository,
	);
	return new QueueConsumer(
		new VaultPurgeConsumer(
			vaultService,
			coordinatorProxyRepository,
			env.RETENTION_NOTIFICATION_QUEUE
				? new CloudflareVaultRetentionEmailQueue(
						env.RETENTION_NOTIFICATION_QUEUE as Queue<VaultRetentionEmailMessage>,
					)
				: undefined,
		),
		new SubscriptionPolicyRefreshConsumer(policyRefreshService),
		new VaultRetentionEmailConsumer(env.EMAIL, env.AUTH_EMAIL_FROM),
	);
}

export class QueueConsumer {
	constructor(
		private readonly vaultPurgeConsumer: VaultPurgeConsumer,
		private readonly policyRefreshConsumer: SubscriptionPolicyRefreshConsumer,
		private readonly retentionEmailConsumer: VaultRetentionEmailConsumer,
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
