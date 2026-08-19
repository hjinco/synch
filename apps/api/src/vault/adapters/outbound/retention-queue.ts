import type { VaultRetentionEmailMessage } from "../../application/dto/queue-messages";
import type { RetentionEmailQueue } from "../../application/ports/outbound/retention-email-queue";
import type { VaultInactivityNotice } from "../../domain/types";

export type { VaultInactivityNotice };

export class CloudflareVaultRetentionEmailQueue
	implements RetentionEmailQueue
{
	constructor(private readonly queue: Queue<VaultRetentionEmailMessage>) {}

	async enqueueDeletionNotice(input: {
		vaultId: string;
		deletedAt: number;
		notice: VaultInactivityNotice;
	}): Promise<void> {
		await this.queue.send({ type: "vault_retention_email", ...input });
	}
}
