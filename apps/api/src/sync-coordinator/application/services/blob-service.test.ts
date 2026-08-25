import { describe, expect, it, vi } from "vitest";
import { SyncCoordinatorApplicationError } from "../errors/coordinator-errors";
import { STAGED_BLOB_STALE_MS } from "../../domain/health-policy";
import type { BlobObjectRepository, SyncTokenVerifier } from "../ports/outbound";
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

			await service.stageBlob(
				"token",
				"vault-1",
				"blob-1",
				100,
			);
			storageUsedBytes = 200;
			await service.stageBlob(
				"token",
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
				"token",
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
			withStageTransaction: vi.fn((_blobId, _now, operation) =>
				operation({
					readFacts: vi.fn(() => ({
						existing: {
							state: "staged" as const,
							sizeBytes: 66_701,
							createdAt: 0,
							},
							referenceFacts: {
								hasCurrentReference: false,
								hasRetainedHistory: false,
								hasActiveStaging: false,
							},
							storageUsedBytes: 0,
						storageLimitBytes: 100_000_000,
						maxFileSizeBytes: 10_000_000,
					})),
					persistStage: vi.fn(),
					pauseSync,
				}),
			),
		});
		const socketService = socketServiceMock();
		const service = createCoordinatorService({
			syncTokenService,
			stateRepository,
			socketService,
		});

		await expect(
			service.stageBlob(
				"token",
				"vault-1",
				"blob-stale",
				66_701,
			),
		).rejects.toMatchObject({ code: "sync_paused" });

		expect(stateRepository.withStageTransaction).toHaveBeenCalledWith(
			"blob-stale",
			expect.any(Number),
			expect.any(Function),
		);
		expect(pauseSync).toHaveBeenCalledWith(
			expect.any(Number),
			expect.stringContaining("blob-stale"),
		);
		expect(socketService.closeAllSockets).toHaveBeenCalledWith(
			4403,
			"sync paused for vault repair",
		);
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
			readBlobFacts: vi.fn(() => ({
				blob: {
					blob_id: "blob-1",
					state: "live" as const,
					size_bytes: 42,
					created_at: 1,
					last_uploaded_at: 1,
					delete_after: null,
				},
				referenceFacts: {
					hasCurrentReference: true,
				hasRetainedHistory: false,
				hasActiveStaging: false,
			},
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
		expect(stateRepository.readBlobFacts).toHaveBeenCalledWith(
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
		const deleteStagedBlob = vi.fn();
		const stateRepository = createTestCoordinatorState({
			withBlobTransaction: vi.fn((_blobId, _now, operation) =>
				operation({
					readFacts: vi.fn(() => ({
						blob: { state: "staged" as const, sizeBytes: 42 },
						referenceFacts: {
							hasCurrentReference: true,
							hasRetainedHistory: false,
							hasActiveStaging: false,
						},
					})),
					deleteStagedBlob,
				}),
			),
		});
		const service = createCoordinatorService({
			syncTokenService,
			stateRepository,
		});

		await service.abortStagedBlob("token", "vault-1", "blob-1");

		expect(stateRepository.withBlobTransaction).toHaveBeenCalledWith(
			"blob-1",
			expect.any(Number),
			expect.any(Function),
		);
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
			withStageTransaction: vi.fn(() => {
				throw new SyncCoordinatorApplicationError("quota_exceeded", {
					message: "simulated quota failure",
				});
			}),
		});
		const service = createCoordinatorService({
			syncTokenService,
			stateRepository,
			socketService: socketServiceMock(),
		});

		await expect(service.stageBlob("token", "vault-1", "blob-1", 42)).rejects.toMatchObject({
			code: "quota_exceeded",
			details: { message: "simulated quota failure" },
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
			withStageTransaction: vi.fn(() => {
				throw new SyncCoordinatorApplicationError("blob_size_changed", {
					message: "simulated blob size conflict",
				});
			}),
		});
		const service = createCoordinatorService({
			syncTokenService,
			stateRepository,
			socketService: socketServiceMock(),
		});

		await expect(service.stageBlob("token", "vault-1", "blob-1", 42)).rejects.toMatchObject({
			code: "blob_size_changed",
			details: { message: "simulated blob size conflict" },
		});
	});
});
