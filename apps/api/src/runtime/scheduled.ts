import { DrizzleSharingStore } from "../sharing/adapters/drizzle-sharing-store";
import { CoordinatorProxyRepository } from "../sync-coordinator/adapters/outbound/durable-object-rpc/coordinator-proxy-repository";
import { readPolarProductIdsByPlanId } from "../billing/adapters/outbound/product-ids";
import {
	readCloudflareProfile,
	type CloudflareRuntimeEnv,
} from "../config/cloudflare";
import { isCommunityEdition } from "../config/deployment-profile";
import { createSubscriptionFeature } from "../composition/features/create-subscription-feature";
import { createVaultRetentionFeature } from "../composition/features/create-vault-feature";
import { createDb } from "../db/client";
import { flushSharingRefreshes } from "../sharing/application/refresh";

export const SHARING_REFRESH_CRON = "*/5 * * * *";
export const VAULT_RETENTION_CRON = "0 */6 * * *";

export async function runScheduledTasks(
	env: CloudflareRuntimeEnv,
	cron: string,
	now = Date.now(),
): Promise<void> {
	if (cron === SHARING_REFRESH_CRON) await runSharingRefreshSchedule(env);
	else if (cron === VAULT_RETENTION_CRON) await runVaultRetentionSchedule(env, now);
}

export async function runSharingRefreshSchedule(
	env: CloudflareRuntimeEnv,
): Promise<void> {
	const sharingStore = new DrizzleSharingStore(createDb(env.DB));
	await flushSharingRefreshes(sharingStore, new CoordinatorProxyRepository(env.SYNC_COORDINATOR));
	await sharingStore.pruneExpiredRequests();
}

export async function runVaultRetentionSchedule(
	env: CloudflareRuntimeEnv,
	now = Date.now(),
): Promise<void> {
	const profile = readCloudflareProfile(env);
	if (isCommunityEdition(profile)) {
		return;
	}
	if (!env.VAULT_PURGE_QUEUE) {
		throw new Error("VAULT_PURGE_QUEUE binding is required");
	}

	const db = createDb(env.DB);
	const subscriptionFeature = createSubscriptionFeature(db, {
		selfHosted: false,
		productIdsByPlanId: readPolarProductIdsByPlanId(env),
	});
	const retention = createVaultRetentionFeature({
		db,
		policyReader: subscriptionFeature.policyReader,
		vaultPurgeQueue: env.VAULT_PURGE_QUEUE,
	});
	await retention.run(now);
}
