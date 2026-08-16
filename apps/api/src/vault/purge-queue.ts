import type { VaultInactivityNotice } from "./retention-queue";

export type VaultPurgeMessage =
	| {
			type: "vault_purge";
			vaultId: string;
			reason?: "manual";
	  }
	| {
			type: "vault_purge";
			vaultId: string;
			reason: "inactivity";
			notice: VaultInactivityNotice;
	  };

export type InactiveVaultPurgeInput = {
	vaultId: string;
	notice: VaultInactivityNotice;
};

export interface VaultPurgeQueue {
	enqueueVaultPurge(vaultId: string): Promise<void>;
	enqueueInactiveVaultPurge(input: InactiveVaultPurgeInput): Promise<void>;
}

export class CloudflareVaultPurgeQueue implements VaultPurgeQueue {
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
