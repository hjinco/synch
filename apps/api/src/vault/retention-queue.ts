/**
 * Everything the deletion notice needs is captured before the vault row is
 * hard deleted, so the notice survives the purge without its own outbox table.
 */
export type VaultInactivityNotice = {
	vaultName: string;
	ownerEmail: string;
	lastCommitAt: number | null;
};

export type VaultRetentionEmailMessage = {
	type: "vault_retention_email";
	vaultId: string;
	deletedAt: number;
	notice: VaultInactivityNotice;
};

export interface VaultRetentionEmailQueue {
	enqueueDeletionNotice(
		input: Omit<VaultRetentionEmailMessage, "type">,
	): Promise<void>;
}

export class CloudflareVaultRetentionEmailQueue
	implements VaultRetentionEmailQueue
{
	constructor(private readonly queue: Queue<VaultRetentionEmailMessage>) {}

	async enqueueDeletionNotice(
		input: Omit<VaultRetentionEmailMessage, "type">,
	): Promise<void> {
		await this.queue.send({ type: "vault_retention_email", ...input });
	}
}
