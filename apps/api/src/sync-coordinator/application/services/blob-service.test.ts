import { describe, expect, it, vi } from "vitest";
import type {
	BlobObjectRepository,
	SyncTokenVerifier,
} from "../ports/outbound";
import {
	createCoordinatorService,
	createTestCoordinatorState,
	socketServiceMock,
} from "../../test-helpers";

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

			await service.stageBlob("token", "vault-1", "blob-1", 100);
			storageUsedBytes = 200;
			await service.stageBlob("token", "vault-1", "blob-2", 100);

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

			await service.stageBlob("token", "vault-1", "blob-1", 100);
			service.dispose();

			await vi.advanceTimersByTimeAsync(300);
			expect(socketService.broadcastStorageStatus).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("quarantines a referenced stale staged blob", async () => {
		const syncTokenService = {
			verifySyncToken: vi.fn(async () => ({
				sub: "user-1",
				vaultId: "vault-1",
				localVaultId: "local-vault-1",
				scope: "vault:sync" as const,
				iat: 100,
				exp: 200,
			})),
		} as unknown as SyncTokenVerifier;
		const pauseSync = vi.fn();
		const stateRepository = createTestCoordinatorState({
			readBlob: vi.fn(() => ({
				blob_id: "blob-stale",
				state: "staged" as const,
				size_bytes: 66_701,
				created_at: 0,
				last_uploaded_at: 0,
				delete_after: 1,
			})),
			pauseSync,
			read: vi.fn(() => ({ hasCurrentReference: true, hasRetainedHistory: false })),
		});
		const socketService = socketServiceMock();
		const service = createCoordinatorService({
			syncTokenService,
			stateRepository,
			socketService,
		});

		await expect(
			service.stageBlob("token", "vault-1", "blob-stale", 66_701),
		).rejects.toMatchObject({ code: "sync_paused" });

		expect(pauseSync).toHaveBeenCalledWith(
			expect.any(Number),
			expect.stringContaining("blob-stale"),
		);
		expect(socketService.closeAllSockets).toHaveBeenCalledWith(
			1013,
			"sync paused for vault repair",
		);
	});

	it("refuses new stages while a repair pause is active", async () => {
		const stateRepository = createTestCoordinatorState({
			readSyncPause: vi.fn(() => ({ pausedAt: 1, reason: "repair in progress" })),
		});
		const service = createCoordinatorService({ stateRepository });
		await expect(service.stageBlob("token", "vault-1", "new-blob", 3))
			.rejects.toMatchObject({ code: "sync_paused" });
		expect(stateRepository.persistStage).not.toHaveBeenCalled();
	});

	it("retains an authenticated upload for GC even after its client token expires", async () => {
		const verifySyncToken = vi.fn(async () => { throw new Error("expired token"); });
		const stateRepository = createTestCoordinatorState({
			readBlob: vi.fn(() => ({ blob_id: "blob", state: "staged" as const, size_bytes: 3, created_at: 1, last_uploaded_at: 1, delete_after: 100 })),
		});
		const service = createCoordinatorService({ stateRepository, syncTokenService: { verifySyncToken } as unknown as SyncTokenVerifier });
		await service.abortStagedBlob("vault-1", "blob");
		expect(verifySyncToken).not.toHaveBeenCalled();
		expect(stateRepository.deleteBlobRecord).not.toHaveBeenCalled();
		expect(stateRepository.adjustStorageUsedBytes).not.toHaveBeenCalled();
		await expect(service.abortStagedBlob("other-vault", "blob")).rejects.toMatchObject({ code: "vault_mismatch" });
	});

	it("skips explicit blob deletion when the blob is still referenced", async () => {
		const syncTokenService = {
			verifySyncToken: vi.fn(async () => ({
				sub: "user-1",
				vaultId: "vault-1",
				localVaultId: "local-vault-1",
				scope: "vault:sync" as const,
				iat: 100,
				exp: 200,
			})),
		} as unknown as SyncTokenVerifier;
		const stateRepository = createTestCoordinatorState({
			readBlob: vi.fn(() => ({
				blob_id: "blob-1",
				state: "live" as const,
				size_bytes: 42,
				created_at: 1,
				last_uploaded_at: 1,
				delete_after: null,
			})),
			read: vi.fn(() => ({
				hasCurrentReference: true,
				hasRetainedHistory: false,
			})),
		});
		const blobRepository = {
			delete: vi.fn(async () => undefined),
		} as unknown as BlobObjectRepository;
		const service = createCoordinatorService({
			syncTokenService,
			stateRepository,
			blobRepository,
		});

		await service.deleteBlob("token", "vault-1", "blob-1");

		expect(syncTokenService.verifySyncToken).toHaveBeenCalledWith(
			"token",
			"vault-1",
		);
		expect(stateRepository.read).toHaveBeenCalledWith(
			"blob-1",
			expect.any(Number),
		);
		expect(blobRepository.delete).not.toHaveBeenCalled();
	});

	it("does not abort a staged blob after it becomes referenced", async () => {
		const syncTokenService = {
			verifySyncToken: vi.fn(async () => ({
				sub: "user-1",
				vaultId: "vault-1",
				localVaultId: "local-vault-1",
				scope: "vault:sync" as const,
				iat: 100,
				exp: 200,
			})),
		} as unknown as SyncTokenVerifier;
		const deleteStagedBlob = vi.fn(() => []);
		const stateRepository = createTestCoordinatorState({
			readBlob: vi.fn(() => ({
				blob_id: "blob-1",
				state: "staged" as const,
				size_bytes: 42,
				created_at: 1,
				last_uploaded_at: 1,
				delete_after: 100,
			})),
			read: vi.fn(() => ({
				hasCurrentReference: true,
				hasRetainedHistory: false,
			})),
			deleteBlobRecord: deleteStagedBlob,
		});
		const service = createCoordinatorService({
			syncTokenService,
			stateRepository,
		});

		await service.abortStagedBlob("vault-1", "blob-1");

		expect(deleteStagedBlob).not.toHaveBeenCalled();
	});

	it("maps blob staging domain failures without parsing error messages", async () => {
		const syncTokenService = {
			verifySyncToken: vi.fn(async () => ({
				sub: "user-1",
				vaultId: "vault-1",
				localVaultId: "local-vault-1",
				scope: "vault:sync" as const,
				iat: 100,
				exp: 200,
			})),
		} as unknown as SyncTokenVerifier;
		const stateRepository = createTestCoordinatorState({
			readStorageUsedBytes: vi.fn(() => 100_000_000),
		});
		const service = createCoordinatorService({
			syncTokenService,
			stateRepository,
			socketService: socketServiceMock(),
		});

		await expect(
			service.stageBlob("token", "vault-1", "blob-1", 42),
		).rejects.toMatchObject({
			code: "quota_exceeded",
		});
	});

	it("preserves the existing conflict response code for blob conflicts", async () => {
		const syncTokenService = {
			verifySyncToken: vi.fn(async () => ({
				sub: "user-1",
				vaultId: "vault-1",
				localVaultId: "local-vault-1",
				scope: "vault:sync" as const,
				iat: 100,
				exp: 200,
			})),
		} as unknown as SyncTokenVerifier;
		const stateRepository = createTestCoordinatorState({
			readBlob: vi.fn(() => ({
				blob_id: "blob-1",
				state: "staged" as const,
				size_bytes: 43,
				created_at: Date.now(),
				last_uploaded_at: Date.now(),
				delete_after: Date.now() + 1000,
			})),
		});
		const service = createCoordinatorService({
			syncTokenService,
			stateRepository,
			socketService: socketServiceMock(),
		});

		await expect(
			service.stageBlob("token", "vault-1", "blob-1", 42),
		).rejects.toMatchObject({
			code: "blob_size_changed",
		});
	});
});
