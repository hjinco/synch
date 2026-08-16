import { readPolarProductIdsByPlanId } from "../billing/product-ids";
import { readCloudflareProfile } from "../config/cloudflare";
import { isCommunityEdition } from "../config/deployment-profile";
import { createDb } from "../db/client";
import { SubscriptionPolicyService } from "../subscription/policy-service";
import { CloudflareVaultPurgeQueue } from "../vault/purge-queue";
import type { VaultPurgeMessage } from "../vault/purge-queue";
import { VaultRepository } from "../vault/repository";
import { VaultRetentionService } from "../vault/retention-service";

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
	const service = new VaultRetentionService(
		new VaultRepository(db),
		new SubscriptionPolicyService(false, db, {
			productIdsByPlanId: readPolarProductIdsByPlanId(env),
		}),
		new CloudflareVaultPurgeQueue(
			env.VAULT_PURGE_QUEUE as Queue<VaultPurgeMessage>,
		),
	);
	await service.run(now);
}
