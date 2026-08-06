import { describe, expect, it, vi } from "vitest";

import type {
	HealthSummaryScheduler,
	SocketGateway,
	SyncTokenVerifier,
} from "../ports";
import {
	CoordinatorSocketConnectionService,
	type VaultInitializer,
} from "./connection-service";

describe("CoordinatorSocketConnectionService", () => {
	it("maps verified claims to the socket session and schedules a health flush", async () => {
		const request = new Request("https://example.com/v1/vaults/vault-1/socket");
		const response = new Response(null, { status: 200 });
		const syncTokenVerifier = createSyncTokenVerifier();
		const vaultInitializer = createVaultInitializer();
		const socketGateway = createSocketGateway(response);
		const healthSummaryScheduler = createHealthSummaryScheduler();
		const service = new CoordinatorSocketConnectionService(
			socketGateway,
			syncTokenVerifier,
			vaultInitializer,
			healthSummaryScheduler,
		);

		await expect(service.openSocket(request, "vault-1")).resolves.toBe(response);

		expect(syncTokenVerifier.requireSyncToken).toHaveBeenCalledWith(
			request,
			"vault-1",
		);
		expect(vaultInitializer.ensureVaultState).toHaveBeenCalledWith("vault-1");
		expect(socketGateway.openSocket).toHaveBeenCalledWith(request, {
			userId: "user-1",
			localVaultId: "local-vault-1",
			vaultId: "vault-1",
			wantsStorageStatus: false,
		});
		expect(healthSummaryScheduler.scheduleSummaryFlush).toHaveBeenCalledOnce();
	});

	it("does not initialize or open a socket when token verification fails", async () => {
		const error = new Error("invalid token");
		const syncTokenVerifier = createSyncTokenVerifier();
		vi.mocked(syncTokenVerifier.requireSyncToken).mockRejectedValue(error);
		const vaultInitializer = createVaultInitializer();
		const socketGateway = createSocketGateway();
		const healthSummaryScheduler = createHealthSummaryScheduler();
		const service = new CoordinatorSocketConnectionService(
			socketGateway,
			syncTokenVerifier,
			vaultInitializer,
			healthSummaryScheduler,
		);

		await expect(
			service.openSocket(new Request("https://example.com"), "vault-1"),
		).rejects.toBe(error);

		expect(vaultInitializer.ensureVaultState).not.toHaveBeenCalled();
		expect(socketGateway.openSocket).not.toHaveBeenCalled();
		expect(healthSummaryScheduler.scheduleSummaryFlush).not.toHaveBeenCalled();
	});

	it("does not open a socket or schedule health when vault initialization fails", async () => {
		const error = new Error("vault unavailable");
		const syncTokenVerifier = createSyncTokenVerifier();
		const vaultInitializer = createVaultInitializer();
		vi.mocked(vaultInitializer.ensureVaultState).mockRejectedValue(error);
		const socketGateway = createSocketGateway();
		const healthSummaryScheduler = createHealthSummaryScheduler();
		const service = new CoordinatorSocketConnectionService(
			socketGateway,
			syncTokenVerifier,
			vaultInitializer,
			healthSummaryScheduler,
		);

		await expect(
			service.openSocket(new Request("https://example.com"), "vault-1"),
		).rejects.toBe(error);

		expect(socketGateway.openSocket).not.toHaveBeenCalled();
		expect(healthSummaryScheduler.scheduleSummaryFlush).not.toHaveBeenCalled();
	});

});

function createSyncTokenVerifier(): SyncTokenVerifier {
	return {
		requireSyncToken: vi.fn(async () => ({
			sub: "user-1",
			localVaultId: "local-vault-1",
			vaultId: "vault-1",
			scope: "vault:sync" as const,
			iat: 1,
			exp: 2,
		})),
	};
}

function createVaultInitializer(): VaultInitializer {
	return {
		ensureVaultState: vi.fn(async () => {}),
	};
}

function createSocketGateway(
	response = new Response(null, { status: 200 }),
): Pick<SocketGateway, "openSocket" | "closeAllSockets"> {
	return {
		openSocket: vi.fn(async () => response),
		closeAllSockets: vi.fn(),
	};
}

function createHealthSummaryScheduler(): HealthSummaryScheduler {
	return {
		scheduleSummaryFlush: vi.fn(async () => {}),
	};
}
