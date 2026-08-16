import { describe, expect, it, vi } from "vitest";

import { getSubscriptionPlanPolicy } from "../subscription/policy";
import {
	FREE_VAULT_INACTIVITY_DELETE_AFTER_MS,
	VaultRetentionService,
} from "./retention-service";
import type { InactiveVaultCandidate } from "./types";

const NOW = Date.UTC(2026, 7, 14, 12);

function candidate(
	overrides: Partial<InactiveVaultCandidate> = {},
): InactiveVaultCandidate {
	return {
		vaultId: "vault-1",
		organizationId: "org-1",
		vaultName: "Work",
		ownerEmail: "owner@example.com",
		lastCommitAt: null,
		...overrides,
	};
}

function setup(
	input: {
		plan?: "free" | "starter";
		candidates?: InactiveVaultCandidate[];
		claimed?: boolean;
	} = {},
) {
	const repository = {
		listInactiveVaultCandidates: vi.fn(async (_since, after: string | null) =>
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
		enqueueVaultPurge: vi.fn(async () => {}),
		enqueueInactiveVaultPurge: vi.fn(async () => {}),
	};
	const service = new VaultRetentionService(repository, policyReader, purgeQueue);
	return { service, repository, policyReader, purgeQueue };
}

describe("VaultRetentionService", () => {
	it("queues a purge carrying the notice a deleted vault can no longer supply", async () => {
		const { service, repository, purgeQueue } = setup({
			candidates: [candidate({ lastCommitAt: 1_000 })],
		});

		await service.run(NOW);

		expect(repository.markVaultDeletionQueued).toHaveBeenCalledWith("vault-1");
		expect(purgeQueue.enqueueInactiveVaultPurge).toHaveBeenCalledWith({
			vaultId: "vault-1",
			notice: {
				vaultName: "Work",
				ownerEmail: "owner@example.com",
				lastCommitAt: 1_000,
			},
		});
	});

	it("asks only for vaults past the inactivity cutoff", async () => {
		const { service, repository } = setup();

		await service.run(NOW);

		expect(repository.listInactiveVaultCandidates).toHaveBeenCalledWith(
			NOW - FREE_VAULT_INACTIVITY_DELETE_AFTER_MS,
			null,
			expect.any(Number),
		);
	});

	it("leaves paid organizations alone", async () => {
		const { service, repository, purgeQueue } = setup({ plan: "starter" });

		await service.run(NOW);

		expect(repository.markVaultDeletionQueued).not.toHaveBeenCalled();
		expect(purgeQueue.enqueueInactiveVaultPurge).not.toHaveBeenCalled();
	});

	it("does not queue a purge when another writer already claimed the vault", async () => {
		const { service, purgeQueue } = setup({ claimed: false });

		await service.run(NOW);

		expect(purgeQueue.enqueueInactiveVaultPurge).not.toHaveBeenCalled();
	});

	it("reads each organization once and restores the vault when queueing fails", async () => {
		const { service, repository, policyReader, purgeQueue } = setup({
			candidates: [candidate(), candidate({ vaultId: "vault-2" })],
		});
		purgeQueue.enqueueInactiveVaultPurge.mockRejectedValue(
			new Error("queue unavailable") as never,
		);

		await expect(service.run(NOW)).rejects.toThrow("queue unavailable");

		expect(policyReader.readOrganizationPolicy).toHaveBeenCalledOnce();
		expect(repository.markVaultDeletionQueueFailed).toHaveBeenCalledWith(
			"vault-1",
			"queue unavailable",
		);
	});
});
