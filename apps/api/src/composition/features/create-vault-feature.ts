import type { AppDb } from "../../db/client";
import type { SubscriptionPolicyReader } from "../../subscription/application";
import type { VaultPurgeMessage, VaultRetentionEmailMessage } from "../../vault/application";
import type { VaultOrganizationReader } from "../../vault/application/ports/inbound/vault-organization-reader";
import type { RunVaultRetention } from "../../vault/application/ports/inbound/run-vault-retention";
import type { VaultService } from "../../vault/application/ports/inbound/vault-service";
import type { VaultPurgeQueue } from "../../vault/application/ports/outbound/vault-purge-queue";
import { VaultPurgeConsumer } from "../../vault/adapters/inbound/queue/purge-consumer";
import { VaultRetentionEmailConsumer } from "../../vault/adapters/inbound/queue/retention-email-consumer";
import { CloudflareVaultPurgeQueue } from "../../vault/adapters/outbound/purge-queue";
import { InlineVaultPurgeQueue } from "../../vault/adapters/outbound/inline-purge-queue";
import { CloudflareVaultRetentionEmailQueue } from "../../vault/adapters/outbound/retention-queue";
import { EmailRetentionNotificationSender } from "../../vault/adapters/outbound/email-retention-notification-sender";
import {
	CoordinatorPurgeWriter,
	type CoordinatorPurgeTransport,
} from "../../vault/adapters/outbound/coordinator-purge-writer";
import { DrizzleVaultStore } from "../../vault/adapters/outbound/drizzle-vault-store";
import { VaultApplicationService } from "../../vault/application/services/vault-service";
import {
	RunVaultRetentionService,
	VaultPurgeService,
} from "../../vault/application/services/vault-lifecycle-service";
import { VaultOrganizationService } from "../../vault/application/services/vault-organization-service";

export type VaultFeature = {
	service: VaultService;
	organizationReader: VaultOrganizationReader;
	purgeConsumer: VaultPurgeConsumer;
	retention: RunVaultRetention;
	retentionEmailConsumer: VaultRetentionEmailConsumer;
};

export type VaultFeatureConfig = {
	db: AppDb;
	policyReader: SubscriptionPolicyReader;
	coordinatorPurgeTransport: CoordinatorPurgeTransport;
	vaultPurgeQueue?: Queue<VaultPurgeMessage>;
	retentionEmailQueue?: Queue<VaultRetentionEmailMessage>;
	email?: SendEmail;
	emailFrom?: string;
};

export function createVaultFeature(config: VaultFeatureConfig): VaultFeature {
	const store = new DrizzleVaultStore(config.db);
	const retentionEmailQueue = config.retentionEmailQueue
		? new CloudflareVaultRetentionEmailQueue(config.retentionEmailQueue)
		: undefined;
	const retentionEmailSender = new EmailRetentionNotificationSender(
		config.email,
		config.emailFrom,
	);
	const purgeConsumer = new VaultPurgeConsumer(
		new VaultPurgeService(
			store,
			new CoordinatorPurgeWriter(config.coordinatorPurgeTransport),
		),
		retentionEmailQueue,
	);
	const purgeQueue: VaultPurgeQueue = config.vaultPurgeQueue
		? new CloudflareVaultPurgeQueue(config.vaultPurgeQueue)
		: new InlineVaultPurgeQueue(purgeConsumer);

	return {
		service: new VaultApplicationService(
			store,
			store,
			store,
			store,
			config.policyReader,
			purgeQueue,
		),
		organizationReader: new VaultOrganizationService(store),
		purgeConsumer,
		retention: new RunVaultRetentionService(
			store,
			config.policyReader,
			purgeQueue,
		),
		retentionEmailConsumer: new VaultRetentionEmailConsumer(retentionEmailSender),
	};
}

/** Composition-only reader for coordinator/subscription integration points. */
export function createVaultOrganizationReader(
	db: AppDb,
): VaultOrganizationReader {
	return new VaultOrganizationService(new DrizzleVaultStore(db));
}

export function createVaultRetentionFeature(config: {
	db: AppDb;
	policyReader: SubscriptionPolicyReader;
	vaultPurgeQueue: Queue<VaultPurgeMessage>;
}): RunVaultRetention {
	const store = new DrizzleVaultStore(config.db);
	return new RunVaultRetentionService(
		store,
		config.policyReader,
		new CloudflareVaultPurgeQueue(config.vaultPurgeQueue),
	);
}
