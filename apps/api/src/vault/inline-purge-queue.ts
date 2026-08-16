import type { VaultPurgeConsumer } from "./purge-consumer";
import type { VaultPurgeQueue } from "./purge-queue";

export class InlineVaultPurgeQueue implements VaultPurgeQueue {
	constructor(private readonly consumer: VaultPurgeConsumer) {}

	async enqueueVaultPurge(vaultId: string): Promise<void> {
		await this.consumer.purgeVault(vaultId);
	}

	async enqueueInactiveVaultPurge(): Promise<void> {
		throw new Error("automatic inactivity purge is unavailable in community edition");
	}
}
