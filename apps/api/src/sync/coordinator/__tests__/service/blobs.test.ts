import { describe, expect, it, vi } from "vitest";
import { HTTPException } from "hono/http-exception";

import { DomainError } from "../../../../errors";
import type { SyncTokenService } from "../../../access/token-service";
import type { BlobRepository } from "../../../blob/repository";
import {
	createCoordinatorService,
	createTestCoordinatorState,
	socketServiceMock,
} from "./helpers";

describe("coordinator blob lifecycle", () => {
	it("coalesces storage status broadcasts and sends the latest snapshot", async () => {
		vi.useFakeTimers();
		try {
			let storageUsedBytes = 100;
			const socketService = socketServiceMock();
			const stateRepository = createTestCoordinatorState({
				readStorageStatus: vi.fn(() => ({
					storageUsedBytes,
					storageLimitBytes: 1_000,
				})),
			});
			const service = createCoordinatorService({
				stateRepository,
				socketService,
				storageStatusBroadcastDelayMs: 300,
			});

			await service.stageBlob(
				new Request("http://example.com"),
				"vault-1",
				"blob-1",
				100,
			);
			storageUsedBytes = 200;
			await service.stageBlob(
				new Request("http://example.com"),
				"vault-1",
				"blob-2",
				100,
			);

			expect(socketService.broadcastStorageStatus).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(299);
			expect(socketService.broadcastStorageStatus).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(1);
			expect(socketService.broadcastStorageStatus).toHaveBeenCalledOnce();
			expect(socketService.broadcastStorageStatus).toHaveBeenCalledWith({
				type: "storage_status_updated",
				storageStatus: {
					storageUsedBytes: 200,
					storageLimitBytes: 1_000,
				},
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("cancels a pending storage status broadcast when disposed", async () => {
		vi.useFakeTimers();
		try {
			const socketService = socketServiceMock();
			const service = createCoordinatorService({
				socketService,
				storageStatusBroadcastDelayMs: 300,
			});

			await service.stageBlob(
				new Request("http://example.com"),
				"vault-1",
				"blob-1",
				100,
			);
			service.dispose();

			await vi.advanceTimersByTimeAsync(300);
			expect(socketService.broadcastStorageStatus).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("quarantines a vault when a stale staged blob is retried", async () => {
		const syncTokenService = {
			requireSyncToken: vi.fn(async () => ({
				sub: "user-1",
				vaultId: "vault-1",
				localVaultId: "local-vault-1",
				scope: "vault:sync" as const,
				iat: 100,
				exp: 200,
			})),
		} as unknown as SyncTokenService;
		const stateRepository = createTestCoordinatorState({
			stageBlob: vi.fn(async () => ({
				status: "sync_paused" as const,
			})),
		});
		const socketService = socketServiceMock();
		const service = createCoordinatorService({
			syncTokenService,
			stateRepository,
			socketService,
		});

		await expect(
			service.stageBlob(
				new Request("http://example.com"),
				"vault-1",
				"blob-stale",
				66_701,
			),
		).rejects.toMatchObject({ status: 403 });

		expect(stateRepository.stageBlob).toHaveBeenCalledWith(
			"blob-stale",
			66_701,
			expect.any(Number),
			expect.any(Number),
		);
		expect(socketService.closeAllSockets).toHaveBeenCalledWith(
			4403,
			"sync paused for vault repair",
		);
	});

	it("skips explicit blob deletion when the blob is still referenced", async () => {
		const syncTokenService = {
			requireSyncToken: vi.fn(async () => ({
				sub: "user-1",
				vaultId: "vault-1",
				localVaultId: "local-vault-1",
				scope: "vault:sync" as const,
				iat: 100,
				exp: 200,
			})),
		} as unknown as SyncTokenService;
		const stateRepository = createTestCoordinatorState({
			readBlob: vi.fn(() => ({
				blob_id: "blob-1",
				state: "live" as const,
				size_bytes: 42,
				created_at: 1,
				last_uploaded_at: 1,
				delete_after: null,
			})),
			isBlobPinned: vi.fn(() => true),
		});
		const blobRepository = {
			delete: vi.fn(async () => undefined),
		} as unknown as BlobRepository;
		const service = createCoordinatorService({
			syncTokenService,
			stateRepository,
			blobRepository,
		});

		await service.deleteBlob(new Request("http://example.com"), "vault-1", "blob-1");

		expect(syncTokenService.requireSyncToken).toHaveBeenCalledWith(
			expect.any(Request),
			"vault-1",
		);
		expect(stateRepository.readBlob).toHaveBeenCalledWith("blob-1");
		expect(stateRepository.isBlobPinned).toHaveBeenCalledWith("blob-1", false);
		expect(blobRepository.delete).not.toHaveBeenCalled();
	});

	it("maps blob staging domain failures without parsing error messages", async () => {
		const syncTokenService = {
			requireSyncToken: vi.fn(async () => ({
				sub: "user-1",
				vaultId: "vault-1",
				localVaultId: "local-vault-1",
				scope: "vault:sync" as const,
				iat: 100,
				exp: 200,
			})),
		} as unknown as SyncTokenService;
		const stateRepository = createTestCoordinatorState({
			stageBlob: vi.fn(async () => {
				throw new DomainError("quota_exceeded", "simulated quota failure");
			}),
		});
		const service = createCoordinatorService({
			syncTokenService,
			stateRepository,
			socketService: socketServiceMock(),
		});

		try {
			await service.stageBlob(
				new Request("http://example.com"),
				"vault-1",
				"blob-1",
				42,
			);
			throw new Error("expected stageBlob to fail");
		} catch (error) {
			if (!(error instanceof HTTPException)) {
				throw error;
			}
			const response = error.getResponse();
			expect(response.status).toBe(413);
			// The message is a synthetic fixture; asserting it verifies that the
			// service passes DomainError messages through to the response body.
			await expect(response.json()).resolves.toEqual({
				error: "quota_exceeded",
				reason: "quota_exceeded",
				message: "simulated quota failure",
			});
		}
	});

	it("preserves the existing conflict response code for blob conflicts", async () => {
		const syncTokenService = {
			requireSyncToken: vi.fn(async () => ({
				sub: "user-1",
				vaultId: "vault-1",
				localVaultId: "local-vault-1",
				scope: "vault:sync" as const,
				iat: 100,
				exp: 200,
			})),
		} as unknown as SyncTokenService;
		const stateRepository = createTestCoordinatorState({
			stageBlob: vi.fn(async () => {
				throw new DomainError("blob_size_changed", "simulated blob size conflict");
			}),
		});
		const service = createCoordinatorService({
			syncTokenService,
			stateRepository,
			socketService: socketServiceMock(),
		});

		try {
			await service.stageBlob(
				new Request("http://example.com"),
				"vault-1",
				"blob-1",
				42,
			);
			throw new Error("expected stageBlob to fail");
		} catch (error) {
			if (!(error instanceof HTTPException)) {
				throw error;
			}
			const response = error.getResponse();
			expect(response.status).toBe(409);
			await expect(response.json()).resolves.toEqual({
				error: "conflict",
				reason: "blob_size_changed",
				message: "simulated blob size conflict",
			});
		}
	});
});
