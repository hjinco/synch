import type { CoordinatorProxyRepository } from "../sync/coordinator/proxy-repository";
import type { VaultPurgeMessage } from "./purge-queue";
import type {
	VaultInactivityNotice,
	VaultRetentionEmailQueue,
} from "./retention-queue";
import type { VaultService } from "./service";

export class VaultPurgeConsumer {
	constructor(
		private readonly vaultService: VaultService,
		private readonly coordinatorProxyRepository: CoordinatorProxyRepository,
		private readonly retentionEmailQueue?: VaultRetentionEmailQueue,
	) {}

	async purgeVault(vaultId: string): Promise<void> {
		await this.vaultService.markVaultPurgeRunning(vaultId);
		try {
			const response = await this.coordinatorProxyRepository.purgeVault(vaultId);
			if (!response.ok) {
				throw new Error(`coordinator purge failed with status ${response.status}`);
			}
			await this.vaultService.hardDeleteVault(vaultId);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.vaultService.markVaultPurgeFailed(vaultId, message);
			throw error;
		}
	}

	async handleMessage(message: Message<VaultPurgeMessage>): Promise<void> {
		const body = message.body;
		if (body?.type !== "vault_purge" || !body.vaultId.trim()) {
			message.ack();
			return;
		}

		try {
			// The vault is already soft deleted by this point, so it is purged
			// whether or not the inactivity notice can be delivered.
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
