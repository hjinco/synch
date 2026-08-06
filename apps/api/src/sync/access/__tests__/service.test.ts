import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
	env: {
		DB: {},
		BETTER_AUTH_URL: "https://example.com",
		BETTER_AUTH_SECRET: "test-secret",
	},
}));

import type { VaultService } from "../../../vault/service";
import { SyncService } from "../service";
import type { SyncTokenService } from "../token-service";

describe("SyncService", () => {
	it("includes the sync format version in issued token responses", async () => {
		const vaultService = {
			getAccessibleVault: vi.fn(async () => ({
				id: "vault-1",
				organizationId: "org-1",
				name: "Vault",
				activeKeyVersion: 1,
				syncFormatVersion: 2,
				createdAt: new Date(0),
				deletedAt: null,
				purgeStatus: null,
				purgeError: null,
			})),
		} as unknown as VaultService;
		const syncTokenService = {
			signSyncToken: vi.fn(async () => "token"),
		} as unknown as SyncTokenService;
		const service = new SyncService(vaultService, syncTokenService, 120);

		const issued = await service.issueSyncToken(
			{ userId: "user-1" },
			{
				vaultId: "vault-1",
				localVaultId: "local-vault-1",
			},
		);

		expect(issued).toMatchObject({
			token: "token",
			vaultId: "vault-1",
			localVaultId: "local-vault-1",
			syncFormatVersion: 2,
		});
	});

	it("rejects issuing a token for a vault the caller cannot access", async () => {
		const vaultService = {
			getAccessibleVault: vi.fn(async () => null),
		} as unknown as VaultService;
		const syncTokenService = {
			signSyncToken: vi.fn(async () => "token"),
		} as unknown as SyncTokenService;
		const service = new SyncService(vaultService, syncTokenService);

		await expect(
			service.issueSyncToken(
				{ userId: "user-1" },
				{
					vaultId: "vault-foreign",
					localVaultId: "local-vault-1",
				},
			),
		).rejects.toMatchObject({
			status: 403,
		});
		expect(syncTokenService.signSyncToken).not.toHaveBeenCalled();
	});

	it("rejects token issuance while coordinator sync is paused", async () => {
		const vaultService = {
			getAccessibleVault: vi.fn(async () => ({
				id: "vault-1",
				organizationId: "org-1",
				name: "Vault",
				activeKeyVersion: 1,
				syncFormatVersion: 2,
				createdAt: new Date(0),
				deletedAt: null,
				purgeStatus: null,
				purgeError: null,
			})),
		} as unknown as VaultService;
		const syncTokenService = {
			signSyncToken: vi.fn(async () => "token"),
		} as unknown as SyncTokenService;
		const syncPauseReader = {
			readSyncPause: vi.fn(async () => ({
				pausedAt: 1,
				reason: "staged blob remained staged for at least one hour",
			})),
		};
		const service = new SyncService(vaultService, syncTokenService, 120, syncPauseReader);

		await expect(
			service.issueSyncToken(
				{ userId: "user-1" },
				{ vaultId: "vault-1", localVaultId: "local-vault-1" },
			),
		).rejects.toMatchObject({ status: 403 });
		expect(syncTokenService.signSyncToken).not.toHaveBeenCalled();
	});
});
