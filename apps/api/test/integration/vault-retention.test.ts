import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { createDb } from "../../src/db/client";
import { getSubscriptionPlanPolicy } from "../../src/subscription/policy";
import { VaultPurgeConsumer } from "../../src/vault/purge-consumer";
import {
	CloudflareVaultPurgeQueue,
	type VaultPurgeMessage,
} from "../../src/vault/purge-queue";
import { VaultRepository } from "../../src/vault/repository";
import { VaultRetentionEmailConsumer } from "../../src/vault/retention-email-consumer";
import {
	CloudflareVaultRetentionEmailQueue,
	type VaultRetentionEmailMessage,
} from "../../src/vault/retention-queue";
import {
	FREE_VAULT_INACTIVITY_DELETE_AFTER_MS,
	VaultRetentionService,
} from "../../src/vault/retention-service";
import { signUpAndCreateVault } from "../helpers/api";

/**
 * Collects what a producer would put on a real queue, so each stage is driven
 * by the same message shape production would deliver.
 */
function recordingQueue<T>(): { sent: T[]; queue: Queue<T> } {
	const sent: T[] = [];
	return {
		sent,
		queue: {
			send: async (message: T) => {
				sent.push(message);
			},
		} as unknown as Queue<T>,
	};
}

function freeRetentionService(
	repository: VaultRepository,
	purgeQueue: CloudflareVaultPurgeQueue,
) {
	return new VaultRetentionService(
		repository,
		{ readOrganizationPolicy: async () => getSubscriptionPlanPolicy("free") },
		purgeQueue,
	);
}

async function backdateVault(vaultId: string, createdAt: number) {
	await env.DB.prepare("UPDATE vault SET created_at = ? WHERE id = ?")
		.bind(createdAt, vaultId)
		.run();
}

function queueMessage<T>(body: T) {
	return { body, ack: vi.fn(), retry: vi.fn() };
}

describe("vault inactivity retention integration", () => {
	it("deletes an inactive free vault and emails the owner afterwards", async () => {
		const fixture = await signUpAndCreateVault("Inactive free vault");
		const now = Date.now();
		await backdateVault(fixture.vaultId, now - FREE_VAULT_INACTIVITY_DELETE_AFTER_MS);

		const repository = new VaultRepository(createDb(env.DB));
		const purges = recordingQueue<VaultPurgeMessage>();
		await freeRetentionService(
			repository,
			new CloudflareVaultPurgeQueue(purges.queue),
		).run(now);

		expect(purges.sent).toEqual([
			{
				type: "vault_purge",
				reason: "inactivity",
				vaultId: fixture.vaultId,
				notice: {
					vaultName: "Inactive free vault",
					ownerEmail: fixture.email,
					lastCommitAt: null,
				},
			},
		]);

		// The vault is claimed before the purge runs, so it is already invisible
		// to the sync token path that gates new commits.
		const claimed = await env.DB.prepare(
			"SELECT deleted_at, purge_status FROM vault WHERE id = ?",
		)
			.bind(fixture.vaultId)
			.first<{ deleted_at: number; purge_status: string }>();
		expect(claimed?.purge_status).toBe("queued");
		expect(claimed?.deleted_at).toBeGreaterThan(0);

		const notices = recordingQueue<VaultRetentionEmailMessage>();
		const purgeConsumer = new VaultPurgeConsumer(
			{
				markVaultPurgeRunning: (vaultId: string) =>
					repository.markVaultPurgeRunning(vaultId),
				markVaultPurgeFailed: (vaultId: string, message: string) =>
					repository.markVaultPurgeFailed(vaultId, message),
				hardDeleteVault: (vaultId: string) => repository.hardDeleteVault(vaultId),
			} as never,
			{
				purgeVault: vi.fn(async () => new Response(null, { status: 204 })),
			} as never,
			new CloudflareVaultRetentionEmailQueue(notices.queue),
		);
		const purgeMessage = queueMessage(purges.sent[0]);
		await purgeConsumer.handleMessage(purgeMessage as never);

		expect(purgeMessage.ack).toHaveBeenCalledOnce();
		const purged = await env.DB.prepare("SELECT id FROM vault WHERE id = ?")
			.bind(fixture.vaultId)
			.first();
		expect(purged).toBeNull();

		const email = {
			send: vi.fn(async (_message: { to: string }) => ({
				messageId: "provider-1",
			})),
		};
		const noticeMessage = queueMessage(notices.sent[0]);
		await new VaultRetentionEmailConsumer(
			email as never,
			"Synch <noreply@synch.run>",
		).handleMessage(noticeMessage as never);

		expect(email.send).toHaveBeenCalledWith(
			expect.objectContaining({ to: fixture.email }),
		);
		expect(noticeMessage.ack).toHaveBeenCalledOnce();
	});

	it("keeps a vault that has synced content inside the inactivity window", async () => {
		const fixture = await signUpAndCreateVault("Recently synced vault");
		const now = Date.now();
		await backdateVault(fixture.vaultId, now - FREE_VAULT_INACTIVITY_DELETE_AFTER_MS);
		await env.DB.prepare(
			`INSERT INTO vault_sync_status (vault_id, last_commit_at, last_flushed_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT (vault_id) DO UPDATE SET last_commit_at = excluded.last_commit_at`,
		)
			.bind(fixture.vaultId, now, now, now, now)
			.run();

		const repository = new VaultRepository(createDb(env.DB));
		const purges = recordingQueue<VaultPurgeMessage>();
		await freeRetentionService(
			repository,
			new CloudflareVaultPurgeQueue(purges.queue),
		).run(now);

		expect(purges.sent).toEqual([]);
		const kept = await env.DB.prepare("SELECT deleted_at FROM vault WHERE id = ?")
			.bind(fixture.vaultId)
			.first<{ deleted_at: number | null }>();
		expect(kept?.deleted_at).toBeNull();
	});
});
