import type { SubscriptionPolicyReader } from "../subscription/policy-service";
import type { VaultPurgeQueue } from "./purge-queue";
import type { InactiveVaultCandidate } from "./types";

/**
 * Free remote vaults are deleted once no content change has been synced for
 * this long. Deletion is immediate: the owner is emailed after the fact, so
 * there is no scheduled-deletion state to keep or cancel.
 */
export const FREE_VAULT_INACTIVITY_DELETE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

const SCAN_PAGE_SIZE = 100;

type InactiveVaultStore = {
	listInactiveVaultCandidates(
		inactiveSince: number,
		afterVaultId: string | null,
		limit: number,
	): Promise<InactiveVaultCandidate[]>;
	markVaultDeletionQueued(vaultId: string): Promise<boolean>;
	markVaultDeletionQueueFailed(vaultId: string, message: string): Promise<void>;
};

export class VaultRetentionService {
	constructor(
		private readonly repository: InactiveVaultStore,
		private readonly policyReader: SubscriptionPolicyReader,
		private readonly purgeQueue: VaultPurgeQueue,
	) {}

	async run(now = Date.now()): Promise<void> {
		const inactiveSince = now - FREE_VAULT_INACTIVITY_DELETE_AFTER_MS;
		const freeByOrganization = new Map<string, boolean>();
		let afterVaultId: string | null = null;

		for (;;) {
			const candidates = await this.repository.listInactiveVaultCandidates(
				inactiveSince,
				afterVaultId,
				SCAN_PAGE_SIZE,
			);
			if (candidates.length === 0) {
				return;
			}
			// Paid candidates are never claimed, so paging past them keeps them
			// from filling every page and starving the free vaults behind them.
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
		if (!(await this.repository.markVaultDeletionQueued(candidate.vaultId))) {
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
			await this.repository.markVaultDeletionQueueFailed(
				candidate.vaultId,
				message,
			);
			throw error;
		}
	}
}
