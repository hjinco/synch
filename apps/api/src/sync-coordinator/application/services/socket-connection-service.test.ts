import { describe, expect, it, vi } from "vitest";

import type { SyncTokenVerifier } from "../ports/outbound";
import { SocketConnectionService } from "./socket-connection-service";

describe("SocketConnectionService", () => {
	it("maps verified claims to a socket session and schedules health", async () => {
		const syncTokenVerifier = createSyncTokenVerifier();
		const vaultInitializer = { ensureVaultState: vi.fn(async () => {}) };
		const healthSummaryScheduler = { scheduleSummaryFlush: vi.fn(async () => {}) };
		const service = new SocketConnectionService(
			syncTokenVerifier,
			vaultInitializer,
			healthSummaryScheduler,
		);

		await expect(service.prepareSocketSession("token", "vault-1")).resolves.toEqual({
			userId: "user-1",
			localVaultId: "local-vault-1",
			vaultId: "vault-1",
			displayName: "User",
			wantsStorageStatus: false,
			wantsPresence: false,
			presenceEntryId: null,
			presenceWatchEntryIds: [],
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
		const service = new SocketConnectionService(
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
		const service = new SocketConnectionService(
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
			displayName: "User",
			scope: "vault:sync" as const,
			iat: 1,
			exp: 2,
		})),
	};
}
