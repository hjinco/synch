import { describe, expect, it, vi } from "vitest";

import { VaultPurgeConsumer } from "./purge-consumer";

describe("VaultPurgeConsumer", () => {
	it("purges coordinator state and hard deletes the vault", async () => {
		const vaultService = {
			markVaultPurgeRunning: vi.fn(async () => {}),
			markVaultPurgeFailed: vi.fn(async () => {}),
			hardDeleteVault: vi.fn(async () => {}),
		};
		const coordinatorProxyRepository = {
			purgeVault: vi.fn(async () => new Response(null, { status: 204 })),
		};
		const consumer = new VaultPurgeConsumer(
			vaultService as never,
			coordinatorProxyRepository as never,
		);

		await consumer.purgeVault("vault-1");

		expect(vaultService.markVaultPurgeRunning).toHaveBeenCalledWith("vault-1");
		expect(coordinatorProxyRepository.purgeVault).toHaveBeenCalledWith("vault-1");
		expect(vaultService.hardDeleteVault).toHaveBeenCalledWith("vault-1");
		expect(vaultService.markVaultPurgeFailed).not.toHaveBeenCalled();
	});

	it("marks purge failures before retrying the queue message", async () => {
		const vaultService = {
			markVaultPurgeRunning: vi.fn(async () => {}),
			markVaultPurgeFailed: vi.fn(async () => {}),
			hardDeleteVault: vi.fn(async () => {}),
		};
		const coordinatorProxyRepository = {
			purgeVault: vi.fn(async () => new Response(null, { status: 500 })),
		};
		const message = {
			body: { type: "vault_purge", vaultId: "vault-1" },
			ack: vi.fn(),
			retry: vi.fn(),
		};
		const consumer = new VaultPurgeConsumer(
			vaultService as never,
			coordinatorProxyRepository as never,
		);

		await consumer.handleBatch({
			messages: [message],
		} as never);

		expect(vaultService.markVaultPurgeFailed).toHaveBeenCalledWith(
			"vault-1",
			"coordinator purge failed with status 500",
		);
		expect(vaultService.hardDeleteVault).not.toHaveBeenCalled();
		expect(message.retry).toHaveBeenCalledOnce();
		expect(message.ack).not.toHaveBeenCalled();
	});

	it("queues the deletion notice only after the vault is purged", async () => {
		const vaultService = purgingVaultService();
		const retentionEmailQueue = { enqueueDeletionNotice: vi.fn(async () => {}) };
		const message = {
			body: inactivityPurgeMessage(),
			ack: vi.fn(),
			retry: vi.fn(),
		};
		const consumer = new VaultPurgeConsumer(
			vaultService as never,
			{
				purgeVault: vi.fn(async () => new Response(null, { status: 204 })),
			} as never,
			retentionEmailQueue,
		);

		await consumer.handleMessage(message as never);

		expect(vaultService.hardDeleteVault).toHaveBeenCalledBefore(
			retentionEmailQueue.enqueueDeletionNotice,
		);
		expect(retentionEmailQueue.enqueueDeletionNotice).toHaveBeenCalledWith({
			vaultId: "vault-1",
			deletedAt: expect.any(Number),
			notice: {
				vaultName: "Work",
				ownerEmail: "owner@example.com",
				lastCommitAt: 1_000,
			},
		});
		expect(message.ack).toHaveBeenCalledOnce();
	});

	it("does not notify when the purge fails", async () => {
		const retentionEmailQueue = { enqueueDeletionNotice: vi.fn(async () => {}) };
		const message = {
			body: inactivityPurgeMessage(),
			ack: vi.fn(),
			retry: vi.fn(),
		};
		const consumer = new VaultPurgeConsumer(
			purgingVaultService() as never,
			{
				purgeVault: vi.fn(async () => new Response(null, { status: 500 })),
			} as never,
			retentionEmailQueue,
		);

		await consumer.handleMessage(message as never);

		expect(retentionEmailQueue.enqueueDeletionNotice).not.toHaveBeenCalled();
		expect(message.retry).toHaveBeenCalledOnce();
	});

	it("still purges an inactive vault whose notice has no usable recipient", async () => {
		const vaultService = purgingVaultService();
		const retentionEmailQueue = { enqueueDeletionNotice: vi.fn(async () => {}) };
		const message = {
			body: {
				...inactivityPurgeMessage(),
				notice: {
					vaultName: "Work",
					ownerEmail: "   ",
					lastCommitAt: 1_000,
				},
			},
			ack: vi.fn(),
			retry: vi.fn(),
		};
		const consumer = new VaultPurgeConsumer(
			vaultService as never,
			{
				purgeVault: vi.fn(async () => new Response(null, { status: 204 })),
			} as never,
			retentionEmailQueue,
		);

		await consumer.handleMessage(message as never);

		expect(vaultService.hardDeleteVault).toHaveBeenCalledWith("vault-1");
		expect(retentionEmailQueue.enqueueDeletionNotice).not.toHaveBeenCalled();
		expect(message.ack).toHaveBeenCalledOnce();
	});
});

function inactivityPurgeMessage() {
	return {
		type: "vault_purge" as const,
		vaultId: "vault-1",
		reason: "inactivity" as const,
		notice: {
			vaultName: "Work",
			ownerEmail: "owner@example.com",
			lastCommitAt: 1_000,
		},
	};
}

function purgingVaultService() {
	return {
		markVaultPurgeRunning: vi.fn(async () => {}),
		markVaultPurgeFailed: vi.fn(async () => {}),
		hardDeleteVault: vi.fn(async () => {}),
	};
}
