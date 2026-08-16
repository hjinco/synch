import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
	env: {
		DB: {},
		BETTER_AUTH_URL: "https://example.com",
		BETTER_AUTH_SECRET: "test-secret",
	},
}));

import { VaultService } from "./service";
import type { VaultRepository } from "./repository";
import { getSubscriptionPlanPolicy } from "../subscription/policy";

const INITIAL_WRAPPER = {
	kind: "password" as const,
	envelope: {
		version: 1,
		keyVersion: 1,
		kdf: {
			name: "argon2id",
			memoryKiB: 65_536,
			iterations: 3,
			parallelism: 1,
			salt: "MDEyMzQ1Njc4OWFiY2RlZg==",
		},
		wrap: {
			algorithm: "aes-256-gcm",
			nonce: "AAECAwQFBgcICQoL",
			ciphertext:
				"c3luY2h2YXVsdC13cmFwcGVkLXZhdWx0LWtleS12MS10ZXN0LWNpcGhlcnRleHQh",
		},
	},
};

describe("VaultService", () => {
	it("passes the vault name through to the repository", async () => {
		const vaultRepository = {
			readDefaultOrganizationIdForUser: vi.fn(async () => "org-1"),
			countVaultsForOrganization: vi.fn(async () => 0),
			vaultNameExistsForOrganization: vi.fn(async () => false),
			createVaultForUser: vi.fn(async () => {
				return {
					id: "vault-1",
					organizationId: "org-1",
					name: "Personal",
					activeKeyVersion: 1,
					createdAt: new Date("2026-04-22T00:00:00.000Z"),
				};
			}),
		} as unknown as VaultRepository;
		const service = new VaultService(vaultRepository);

		const created = await service.createVault("user-1", "Personal", INITIAL_WRAPPER);

		expect(created.id).toBe("vault-1");
		expect(created.name).toBe("Personal");
		expect(vaultRepository.createVaultForUser).toHaveBeenCalledWith(
			"user-1",
			"org-1",
			"Personal",
			INITIAL_WRAPPER,
		);
	});

	it("allows additional vaults when the policy has no vault limit", async () => {
		const vaultRepository = {
			readDefaultOrganizationIdForUser: vi.fn(async () => "org-1"),
			countVaultsForOrganization: vi.fn(async () => 1),
			vaultNameExistsForOrganization: vi.fn(async () => false),
			createVaultForUser: vi.fn(async () => {
				return {
					id: "vault-2",
					organizationId: "org-1",
					name: "Work",
					activeKeyVersion: 1,
					createdAt: new Date("2026-04-22T00:00:00.000Z"),
				};
			}),
		} as unknown as VaultRepository;
		const service = new VaultService(vaultRepository, {
			readOrganizationPolicy: vi.fn(async () => getSubscriptionPlanPolicy("self_hosted")),
		});

		const created = await service.createVault("user-1", "Work", INITIAL_WRAPPER);

		expect(created.id).toBe("vault-2");
		expect(vaultRepository.createVaultForUser).toHaveBeenCalled();
	});

	it("rejects duplicate active vault names in the same organization", async () => {
		const vaultRepository = {
			readDefaultOrganizationIdForUser: vi.fn(async () => "org-1"),
			countVaultsForOrganization: vi.fn(async () => 1),
			vaultNameExistsForOrganization: vi.fn(async () => true),
			createVaultForUser: vi.fn(),
		} as unknown as VaultRepository;
		const service = new VaultService(vaultRepository, {
			readOrganizationPolicy: vi.fn(async () => getSubscriptionPlanPolicy("self_hosted")),
		});

		await expect(service.createVault("user-1", "Work", INITIAL_WRAPPER)).rejects.toMatchObject({
			status: 409,
		});
		expect(vaultRepository.createVaultForUser).not.toHaveBeenCalled();
	});

	it("keeps vault deletion retryable when purge enqueue fails", async () => {
		const enqueueError = new Error("queue unavailable");
		const vaultRepository = {
			userCanManageVault: vi.fn(async () => true),
			markVaultDeletionQueued: vi.fn(async () => {}),
			markVaultDeletionQueueFailed: vi.fn(async () => {}),
			markVaultPurgeFailed: vi.fn(async () => {}),
		} as unknown as VaultRepository;
		const vaultPurgeQueue = {
			enqueueVaultPurge: vi.fn(async () => {
				throw enqueueError;
			}),
			enqueueInactiveVaultPurge: vi.fn(async () => {}),
		};
		const service = new VaultService(vaultRepository, undefined, vaultPurgeQueue);

		await expect(service.deleteVault("user-1", "vault-1")).rejects.toThrow(enqueueError);

		expect(vaultRepository.markVaultDeletionQueued).toHaveBeenCalledWith("vault-1");
		expect(vaultPurgeQueue.enqueueVaultPurge).toHaveBeenCalledWith("vault-1");
		expect(vaultRepository.markVaultDeletionQueueFailed).toHaveBeenCalledWith(
			"vault-1",
			"queue unavailable",
		);
		expect(vaultRepository.markVaultPurgeFailed).not.toHaveBeenCalled();
	});
});
