import type { VaultPurgeMessage } from "../../../application/dto/queue-messages";
import type { PurgeVault } from "../../../application/ports/inbound/purge-vault";
import type { RetentionEmailQueue } from "../../../application/ports/outbound/retention-email-queue";
import type { VaultInactivityNotice } from "../../../domain/types";

export class VaultPurgeConsumer {
	constructor(
		private readonly purgeVaultUseCase: PurgeVault,
		private readonly retentionEmailQueue?: RetentionEmailQueue,
	) {}

	async purgeVault(vaultId: string): Promise<void> {
		await this.purgeVaultUseCase.purgeVault(vaultId);
	}

	async handleMessage(message: Message<VaultPurgeMessage>): Promise<void> {
		const body = message.body;
		if (body?.type !== "vault_purge" || !body.vaultId.trim()) {
			message.ack();
			return;
		}

		try {
			await this.purgeVault(body.vaultId);
			if (body.reason === "inactivity" && isDeliverableNotice(body.notice)) {
				await this.retentionEmailQueue?.enqueueDeletionNotice({
					vaultId: body.vaultId,
					deletedAt: Date.now(),
					notice: body.notice,
				});
			}
			message.ack();
		} catch {
			message.retry();
		}
	}

	async handleBatch(batch: MessageBatch<VaultPurgeMessage>): Promise<void> {
		for (const message of batch.messages) {
			await this.handleMessage(message);
		}
	}
}

function isDeliverableNotice(
	notice: VaultInactivityNotice | undefined,
): notice is VaultInactivityNotice {
	return typeof notice?.ownerEmail === "string" && notice.ownerEmail.includes("@");
}
