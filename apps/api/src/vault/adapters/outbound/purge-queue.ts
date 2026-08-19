import type { VaultPurgeMessage } from "../../application/dto/queue-messages";
import type { VaultPurgeQueue as VaultPurgePort } from "../../application/ports/outbound/vault-purge-queue";
import type { VaultInactivityNotice } from "../../domain/types";

export type InactiveVaultPurgeInput = {
	vaultId: string;
	notice: VaultInactivityNotice;
};

export class CloudflareVaultPurgeQueue implements VaultPurgePort {
	constructor(private readonly queue: Queue<VaultPurgeMessage>) {}

	async enqueueVaultPurge(vaultId: string): Promise<void> {
		await this.queue.send({ type: "vault_purge", vaultId });
	}

	async enqueueInactiveVaultPurge(
		input: InactiveVaultPurgeInput,
	): Promise<void> {
		await this.queue.send({
			type: "vault_purge",
			reason: "inactivity",
			...input,
		});
	}
}
