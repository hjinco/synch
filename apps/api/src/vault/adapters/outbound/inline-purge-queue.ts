import type { VaultPurgeQueue } from "../../application/ports/outbound/vault-purge-queue";
import type { VaultPurgeConsumer } from "../inbound/queue/purge-consumer";

export class InlineVaultPurgeQueue implements VaultPurgeQueue {
	constructor(private readonly consumer: VaultPurgeConsumer) {}

	async enqueueVaultPurge(vaultId: string): Promise<void> {
		await this.consumer.purgeVault(vaultId);
	}

	async enqueueInactiveVaultPurge(): Promise<void> {
		throw new Error("automatic inactivity purge is unavailable in community edition");
	}
}
