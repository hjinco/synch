import { describe, expect, it, vi } from "vitest";

import { VaultPurgeConsumer } from "./purge-consumer";

describe("VaultPurgeConsumer", () => {
	it("acks after purge and queues a valid inactivity notice", async () => {
		const purgeVault = vi.fn(async () => {});
		const retentionEmailQueue = { enqueueDeletionNotice: vi.fn(async () => {}) };
		const message = {
			body: {
				type: "vault_purge" as const,
				vaultId: "vault-1",
				reason: "inactivity" as const,
				notice: {
					vaultName: "Work",
					ownerEmail: "owner@example.com",
					lastCommitAt: 1_000,
				},
			},
			ack: vi.fn(),
			retry: vi.fn(),
		};
		const consumer = new VaultPurgeConsumer({ purgeVault }, retentionEmailQueue);

		await consumer.handleMessage(message as never);

		expect(purgeVault).toHaveBeenCalledWith("vault-1");
		expect(retentionEmailQueue.enqueueDeletionNotice).toHaveBeenCalledWith({
			vaultId: "vault-1",
			deletedAt: expect.any(Number),
			notice: message.body.notice,
		});
		expect(message.ack).toHaveBeenCalledOnce();
	});

	it("retries when the purge fails", async () => {
		const message = {
			body: { type: "vault_purge", vaultId: "vault-1" },
			ack: vi.fn(),
			retry: vi.fn(),
		};
		const consumer = new VaultPurgeConsumer({
			purgeVault: vi.fn(async () => {
				throw new Error("coordinator unavailable");
			}),
		});

		await consumer.handleMessage(message as never);

		expect(message.retry).toHaveBeenCalledOnce();
		expect(message.ack).not.toHaveBeenCalled();
	});

	it("acks malformed messages without invoking the use case", async () => {
		const purgeVault = vi.fn(async () => {});
		const message = { body: { type: "unknown" }, ack: vi.fn(), retry: vi.fn() };

		await new VaultPurgeConsumer({ purgeVault }).handleMessage(message as never);

		expect(purgeVault).not.toHaveBeenCalled();
		expect(message.ack).toHaveBeenCalledOnce();
	});
});
