import { readPolarProductIdsByPlanId } from "../billing/adapters/outbound/product-ids";
import { readCloudflareProfile } from "../config/cloudflare";
import { isCommunityEdition } from "../config/deployment-profile";
import { createSubscriptionFeature } from "../composition/features/create-subscription-feature";
import { createVaultRetentionFeature } from "../composition/features/create-vault-feature";
import { createDb } from "../db/client";
import type { VaultPurgeMessage } from "../vault/application";

export async function runVaultRetentionSchedule(
	env: Env,
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
		vaultPurgeQueue: env.VAULT_PURGE_QUEUE as Queue<VaultPurgeMessage>,
	});
	await retention.run(now);
}
