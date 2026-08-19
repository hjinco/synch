import { describe, expect, it, vi } from "vitest";

import type { SyncTokenVerifier } from "../../ports/outbound";
import { CoordinatorSocketConnectionService } from "./connection-service";

describe("CoordinatorSocketConnectionService", () => {
	it("maps verified claims to a socket session and schedules health", async () => {
		const syncTokenVerifier = createSyncTokenVerifier();
		const vaultInitializer = { ensureVaultState: vi.fn(async () => {}) };
		const healthSummaryScheduler = { scheduleSummaryFlush: vi.fn(async () => {}) };
		const service = new CoordinatorSocketConnectionService(
			syncTokenVerifier,
			vaultInitializer,
			healthSummaryScheduler,
		);

		await expect(service.prepareSocketSession("token", "vault-1")).resolves.toEqual({
			userId: "user-1",
			localVaultId: "local-vault-1",
			vaultId: "vault-1",
			wantsStorageStatus: false,
		});
		await service.completeSocketOpen();
		expect(syncTokenVerifier.verifySyncToken).toHaveBeenCalledWith("token", "vault-1");
		expect(vaultInitializer.ensureVaultState).toHaveBeenCalledWith("vault-1");
		expect(healthSummaryScheduler.scheduleSummaryFlush).toHaveBeenCalledOnce();
	});

	it("does not initialize when token verification fails", async () => {
		const error = new Error("invalid token");
		const syncTokenVerifier = createSyncTokenVerifier();
		vi.mocked(syncTokenVerifier.verifySyncToken).mockRejectedValue(error);
		const vaultInitializer = { ensureVaultState: vi.fn(async () => {}) };
		const service = new CoordinatorSocketConnectionService(
			syncTokenVerifier,
			vaultInitializer,
			{ scheduleSummaryFlush: vi.fn(async () => {}) },
		);

		await expect(service.prepareSocketSession("token", "vault-1")).rejects.toBe(error);
		expect(vaultInitializer.ensureVaultState).not.toHaveBeenCalled();
	});

	it("does not schedule health when vault initialization fails", async () => {
		const error = new Error("vault unavailable");
		const vaultInitializer = { ensureVaultState: vi.fn(async () => { throw error; }) };
		const scheduler = { scheduleSummaryFlush: vi.fn(async () => {}) };
		const service = new CoordinatorSocketConnectionService(
			createSyncTokenVerifier(),
			vaultInitializer,
			scheduler,
		);

		await expect(service.prepareSocketSession("token", "vault-1")).rejects.toBe(error);
		expect(scheduler.scheduleSummaryFlush).not.toHaveBeenCalled();
	});
});

function createSyncTokenVerifier(): SyncTokenVerifier {
	return {
		verifySyncToken: vi.fn(async (_token: string | null | undefined, vaultId = "vault-1") => ({
			sub: "user-1",
			vaultId,
			localVaultId: "local-vault-1",
			scope: "vault:sync" as const,
			iat: 1,
			exp: 2,
		})),
	};
}
