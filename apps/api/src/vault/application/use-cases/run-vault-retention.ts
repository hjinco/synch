import type { SubscriptionPolicyReader } from "../../../subscription/application";
import type { InactiveVaultCandidate } from "../../domain/types";
import type { RunVaultRetention } from "../ports/inbound/run-vault-retention";
import type { VaultLifecycleStore } from "../ports/outbound/vault-lifecycle-store";
import type { VaultPurgeQueue } from "../ports/outbound/vault-purge-queue";

/** Free remote vaults are deleted after 90 days without a synced change. */
export const FREE_VAULT_INACTIVITY_DELETE_AFTER_MS =
	90 * 24 * 60 * 60 * 1000;
const SCAN_PAGE_SIZE = 100;

export class RunVaultRetentionUseCase implements RunVaultRetention {
	constructor(
		private readonly store: VaultLifecycleStore,
		private readonly policyReader: SubscriptionPolicyReader,
		private readonly purgeQueue: VaultPurgeQueue,
	) {}

	async run(now = Date.now()): Promise<void> {
		const inactiveSince = now - FREE_VAULT_INACTIVITY_DELETE_AFTER_MS;
		const freeByOrganization = new Map<string, boolean>();
		let afterVaultId: string | null = null;

		for (;;) {
			const candidates = await this.store.listInactiveVaultCandidates(
				inactiveSince,
				afterVaultId,
				SCAN_PAGE_SIZE,
			);
			if (candidates.length === 0) {
				return;
			}
			afterVaultId = candidates[candidates.length - 1]?.vaultId ?? null;

			for (const candidate of candidates) {
				if (
					await this.isFreeOrganization(
						candidate.organizationId,
						freeByOrganization,
					)
				) {
					await this.deleteInactiveVault(candidate);
				}
			}

			if (candidates.length < SCAN_PAGE_SIZE) {
				return;
			}
		}
	}

	private async isFreeOrganization(
		organizationId: string,
		cache: Map<string, boolean>,
	): Promise<boolean> {
		const cached = cache.get(organizationId);
		if (cached !== undefined) {
			return cached;
		}

		const policy = await this.policyReader.readOrganizationPolicy(organizationId);
		const isFree = policy.id === "free";
		cache.set(organizationId, isFree);
		return isFree;
	}

	private async deleteInactiveVault(
		candidate: InactiveVaultCandidate,
	): Promise<void> {
		if (!(await this.store.markVaultDeletionQueued(candidate.vaultId))) {
			return;
		}

		try {
			await this.purgeQueue.enqueueInactiveVaultPurge({
				vaultId: candidate.vaultId,
				notice: {
					vaultName: candidate.vaultName,
					ownerEmail: candidate.ownerEmail,
					lastCommitAt: candidate.lastCommitAt,
				},
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.store.markVaultDeletionQueueFailed(candidate.vaultId, message);
			throw error;
		}
	}
}
