import { describe, expect, it, vi } from "vitest";

import { BlobGcService } from "./blob-gc-service";
import type { BlobPendingDeleteTransaction } from "../ports/outbound";

function blob(blobId: string) {
	return {
		blob_id: blobId,
		state: "pending_delete" as const,
		size_bytes: 10,
		created_at: 1,
		last_uploaded_at: 1,
		delete_after: 1,
	};
}

function createFixture() {
	const fixture = {
		vaultStateStore: { readVaultId: vi.fn(() => "vault-1") },
		blobGcStore: {
			expireEntryVersions: vi.fn(),
			listCollectibleBlobs: vi.fn(() => []),
			readCollectibleBlob: vi.fn((blobId: string) =>
				blobId === "blob-1" || blobId === "blob-2" ? blob(blobId) : null,
			),
			withPendingDeleteTransaction: vi.fn(runPendingDeleteTransaction),
			deleteCollectibleBlobs: vi.fn((blobIds: readonly string[]) =>
				blobIds.map((blobId) => blob(blobId)),
			),
			deleteBlobIfCollectible: vi.fn(() => "deleted" as const),
			readGcDeadlines: vi.fn(() => []),
		},
		blobStorage: {
			exists: vi.fn(async () => true),
			delete: vi.fn(async () => {}),
			deleteMany: vi.fn(
				async (): Promise<{ failedKeys: readonly string[] }> => ({
					failedKeys: [],
				}),
			),
			deleteByPrefix: vi.fn(async () => {}),
		},
		objectKeyBuilder: {
			blobObjectKey: (vaultId: string, blobId: string) => `${vaultId}/${blobId}`,
			blobObjectKeyPrefix: (vaultId: string) => `${vaultId}/`,
		},
		healthStore: { recordGcCompleted: vi.fn() },
		maintenanceScheduler: { defer: vi.fn(async () => {}) },
		healthService: {
			scheduleSummaryFlush: vi.fn(async () => {}),
			notifyStorageStatusChanged: vi.fn(),
		},
	};
	const useCase = new BlobGcService(
		fixture.vaultStateStore,
		fixture.blobGcStore,
		fixture.blobStorage,
		fixture.objectKeyBuilder,
		fixture.healthStore,
		fixture.maintenanceScheduler,
		fixture.healthService,
	);
	return { fixture, useCase };
}

function runPendingDeleteTransaction(
	_blobId: string,
	_now: number,
	operation: (transaction: BlobPendingDeleteTransaction) => void,
): void {
	operation({
		readFacts: vi.fn(() => ({
			state: "pending_delete" as const,
			deleteAfter: 1,
			hasCurrentReference: false,
			hasRetainedHistory: false,
		})),
		markPendingDelete: vi.fn(),
	});
}

describe("BlobGcService purged blob collection", () => {
	it("deduplicates candidates and deletes objects before sqlite rows", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(2);
		try {
			const { fixture, useCase } = createFixture();
			const scheduleNext = vi.spyOn(useCase, "scheduleNext");

			await useCase.collectPurgedBlobs("vault-1", ["blob-1", "blob-1", "blob-2"]);

			expect(fixture.blobGcStore.withPendingDeleteTransaction).toHaveBeenCalledTimes(2);
			expect(fixture.blobStorage.deleteMany).toHaveBeenCalledWith([
				"vault-1/blob-1",
				"vault-1/blob-2",
			]);
			expect(fixture.blobGcStore.deleteCollectibleBlobs).toHaveBeenCalledWith(
				["blob-1", "blob-2"],
				2,
			);
			expect(fixture.blobStorage.delete).not.toHaveBeenCalled();
			expect(scheduleNext).toHaveBeenCalledWith(2);
			expect(fixture.healthService.scheduleSummaryFlush).toHaveBeenCalledWith(2);
			expect(fixture.healthService.notifyStorageStatusChanged).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not delete sqlite rows when the object batch fails", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(2);
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const { fixture, useCase } = createFixture();
			fixture.blobStorage.deleteMany.mockRejectedValue(new Error("temporary failure"));
			const scheduleNext = vi.spyOn(useCase, "scheduleNext");

			await useCase.collectPurgedBlobs("vault-1", ["blob-1", "blob-2"]);

			expect(fixture.blobGcStore.deleteCollectibleBlobs).not.toHaveBeenCalled();
			expect(fixture.healthService.notifyStorageStatusChanged).not.toHaveBeenCalled();
			expect(scheduleNext).toHaveBeenCalledWith(2);
			expect(consoleError).toHaveBeenCalledWith(
				"[sync-coordinator] immediate purged blob deletion failed",
				expect.objectContaining({
					vaultId: "vault-1",
					blobIds: ["blob-1", "blob-2"],
				}),
			);
		} finally {
			consoleError.mockRestore();
			vi.useRealTimers();
		}
	});

	it("deletes sqlite rows for objects that succeeded when a batch is partial", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(2);
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const { fixture, useCase } = createFixture();
			fixture.blobStorage.deleteMany.mockResolvedValue({
				failedKeys: ["vault-1/blob-2"],
			});

			await useCase.collectPurgedBlobs("vault-1", ["blob-1", "blob-2"]);

			expect(fixture.blobGcStore.deleteCollectibleBlobs).toHaveBeenCalledWith(
				["blob-1"],
				2,
			);
			expect(fixture.healthService.notifyStorageStatusChanged).toHaveBeenCalledOnce();
			expect(consoleError).toHaveBeenCalledWith(
				"[sync-coordinator] immediate purged blob deletion failed",
				expect.objectContaining({
					vaultId: "vault-1",
					blobIds: ["blob-1", "blob-2"],
				}),
			);
		} finally {
			consoleError.mockRestore();
			vi.useRealTimers();
		}
	});

	it("does nothing for an empty candidate list", async () => {
		const { fixture, useCase } = createFixture();
		const scheduleNext = vi.spyOn(useCase, "scheduleNext");

		await useCase.collectPurgedBlobs("vault-1", []);

		expect(fixture.blobGcStore.expireEntryVersions).not.toHaveBeenCalled();
		expect(scheduleNext).not.toHaveBeenCalled();
		expect(fixture.healthService.scheduleSummaryFlush).not.toHaveBeenCalled();
	});

	it("skips candidates that are not collectible", async () => {
		const { fixture, useCase } = createFixture();
		fixture.blobGcStore.readCollectibleBlob.mockReturnValue(null);

		await useCase.collectPurgedBlobs("vault-1", ["missing"]);

		expect(fixture.blobGcStore.withPendingDeleteTransaction).toHaveBeenCalledWith(
			"missing",
			expect.any(Number),
			expect.any(Function),
		);
		expect(fixture.blobGcStore.deleteCollectibleBlobs).not.toHaveBeenCalled();
		expect(fixture.blobStorage.deleteMany).not.toHaveBeenCalled();
		expect(fixture.healthService.notifyStorageStatusChanged).not.toHaveBeenCalled();
	});
});
