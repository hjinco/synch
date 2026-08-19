import { describe, expect, it, vi } from "vitest";

import { getSubscriptionPlanPolicy } from "../../../subscription/domain/policy";
import type { InactiveVaultCandidate } from "../../domain/types";
import type { VaultLifecycleStore } from "../ports/outbound/vault-lifecycle-store";
import type { VaultPurgeQueue } from "../ports/outbound/vault-purge-queue";
import { FREE_VAULT_INACTIVITY_DELETE_AFTER_MS, RunVaultRetentionUseCase } from "./run-vault-retention";

const NOW = Date.UTC(2026, 7, 14, 12);

function candidate(overrides: Partial<InactiveVaultCandidate> = {}): InactiveVaultCandidate {
	return {
		vaultId: "vault-1",
		organizationId: "org-1",
		vaultName: "Work",
		ownerEmail: "owner@example.com",
		lastCommitAt: null,
		...overrides,
	};
}

function setup(input: {
	plan?: "free" | "starter";
	candidates?: InactiveVaultCandidate[];
	claimed?: boolean;
} = {}) {
	const store = {
		listInactiveVaultCandidates: vi.fn(async (_since: number, after: string | null) =>
			after ? [] : (input.candidates ?? [candidate()]),
		),
		markVaultDeletionQueued: vi.fn(async () => input.claimed ?? true),
		markVaultDeletionQueueFailed: vi.fn(async () => {}),
	};
	const policyReader = {
		readOrganizationPolicy: vi.fn(async () =>
			getSubscriptionPlanPolicy(input.plan ?? "free"),
		),
	};
	const purgeQueue = {
		enqueueInactiveVaultPurge: vi.fn(async () => {}),
	};
	const service = new RunVaultRetentionUseCase(
		store as unknown as VaultLifecycleStore,
		policyReader,
		purgeQueue as unknown as VaultPurgeQueue,
	);
	return { service, store, policyReader, purgeQueue };
}

describe("RunVaultRetentionUseCase", () => {
	it("queues a purge carrying the notice before hard deletion", async () => {
		const { service, store, purgeQueue } = setup({
			candidates: [candidate({ lastCommitAt: 1_000 })],
		});

		await service.run(NOW);

		expect(store.markVaultDeletionQueued).toHaveBeenCalledWith("vault-1");
		expect(purgeQueue.enqueueInactiveVaultPurge).toHaveBeenCalledWith({
			vaultId: "vault-1",
			notice: {
				vaultName: "Work",
				ownerEmail: "owner@example.com",
				lastCommitAt: 1_000,
			},
		});
	});

	it("uses the inactivity cutoff and leaves paid organizations alone", async () => {
		const { service, store, purgeQueue } = setup({ plan: "starter" });

		await service.run(NOW);

		expect(store.listInactiveVaultCandidates).toHaveBeenCalledWith(
			NOW - FREE_VAULT_INACTIVITY_DELETE_AFTER_MS,
			null,
			expect.any(Number),
		);
		expect(store.markVaultDeletionQueued).not.toHaveBeenCalled();
		expect(purgeQueue.enqueueInactiveVaultPurge).not.toHaveBeenCalled();
	});

	it("restores the vault when queueing fails", async () => {
		const { service, store, policyReader, purgeQueue } = setup({
			candidates: [candidate(), candidate({ vaultId: "vault-2" })],
		});
		purgeQueue.enqueueInactiveVaultPurge.mockRejectedValue(new Error("queue unavailable"));

		await expect(service.run(NOW)).rejects.toThrow("queue unavailable");
		expect(policyReader.readOrganizationPolicy).toHaveBeenCalledOnce();
		expect(store.markVaultDeletionQueueFailed).toHaveBeenCalledWith(
			"vault-1",
			"queue unavailable",
		);
	});
});
