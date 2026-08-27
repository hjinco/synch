import { describe, expect, it, vi } from "vitest";

import type { VaultService } from "../../../vault/application";
import type { SyncTokenClaims } from "../dto/token";
import { IssueSyncTokenUseCase } from "./issue-sync-token";

function accessibleVault() {
	return {
		id: "vault-1",
		organizationId: "org-1",
		name: "Vault",
		activeKeyVersion: 1,
		createdAt: new Date(0),
		deletedAt: null,
		purgeStatus: null,
		purgeError: null,
	};
}

describe("IssueSyncTokenUseCase", () => {
	it("issues a token for an accessible vault", async () => {
		const vaultService = {
			getAccessibleVault: vi.fn(async () => accessibleVault()),
		} as unknown as VaultService;
		const signer = {
			signSyncToken: vi.fn(async (_claims: SyncTokenClaims) => "token"),
		};
		const pauseReader = { readSyncPause: vi.fn(async () => null) };
		const useCase = new IssueSyncTokenUseCase(vaultService, signer, pauseReader, 120);

		await expect(
			useCase.issueSyncToken({
				userId: "user-1",
				vaultId: "vault-1",
				localVaultId: "local-vault-1",
				displayName: "Ada",
			}),
		).resolves.toMatchObject({
			token: "token",
			vaultId: "vault-1",
			localVaultId: "local-vault-1",
			syncFormatVersion: 2,
		});
		expect(signer.signSyncToken).toHaveBeenCalledWith(
			expect.objectContaining({
				sub: "user-1",
				vaultId: "vault-1",
				localVaultId: "local-vault-1",
				displayName: "Ada",
				scope: "vault:sync",
			}),
		);
	});

	it("rejects issuing a token for a vault the caller cannot access", async () => {
		const vaultService = {
			getAccessibleVault: vi.fn(async () => null),
		} as unknown as VaultService;
		const signer = { signSyncToken: vi.fn(async () => "token") };
		const pauseReader = { readSyncPause: vi.fn(async () => null) };
		const useCase = new IssueSyncTokenUseCase(vaultService, signer, pauseReader);

		await expect(
			useCase.issueSyncToken({
				userId: "user-1",
				vaultId: "vault-foreign",
				localVaultId: "local-vault-1",
				displayName: "Ada",
			}),
		).rejects.toMatchObject({ code: "vault_access_denied" });
		expect(signer.signSyncToken).not.toHaveBeenCalled();
	});

	it("rejects token issuance while coordinator sync is paused", async () => {
		const vaultService = {
			getAccessibleVault: vi.fn(async () => accessibleVault()),
		} as unknown as VaultService;
		const signer = { signSyncToken: vi.fn(async () => "token") };
		const pauseReader = {
			readSyncPause: vi.fn(async () => ({
				pausedAt: 1,
				reason: "staged blob remained staged for at least one hour",
			})),
		};
		const useCase = new IssueSyncTokenUseCase(vaultService, signer, pauseReader);

		await expect(
			useCase.issueSyncToken({
				userId: "user-1",
				vaultId: "vault-1",
				localVaultId: "local-vault-1",
				displayName: "Ada",
			}),
		).rejects.toMatchObject({ code: "sync_paused" });
		expect(signer.signSyncToken).not.toHaveBeenCalled();
	});
});
