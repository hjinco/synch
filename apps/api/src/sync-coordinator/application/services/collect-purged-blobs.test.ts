import { describe, expect, it, vi } from "vitest";

import { BlobGcService } from "./blob-gc-service";

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
			markBlobPendingDeleteIfUnpinned: vi.fn(),
			deleteBlobIfCollectible: vi.fn(() => "deleted" as const),
			nextGcAt: vi.fn(() => null),
		},
		blobStorage: {
			exists: vi.fn(async () => true),
			delete: vi.fn(async (key: string) => {
				if (key.endsWith("blob-1")) throw new Error("temporary failure");
			}),
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

describe("BlobGcService purged blob collection", () => {
	it("deduplicates candidates and continues after an individual deletion failure", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(2);
		try {
			const { fixture, useCase } = createFixture();
			const scheduleNext = vi.spyOn(useCase, "scheduleNext");

			await useCase.collectPurgedBlobs("vault-1", ["blob-1", "blob-1", "blob-2"]);

			expect(fixture.blobGcStore.markBlobPendingDeleteIfUnpinned).toHaveBeenCalledTimes(2);
			expect(fixture.blobStorage.delete).toHaveBeenCalledTimes(2);
			expect(fixture.blobGcStore.deleteBlobIfCollectible).toHaveBeenCalledTimes(1);
			expect(scheduleNext).toHaveBeenCalledWith(2);
			expect(fixture.healthService.scheduleSummaryFlush).toHaveBeenCalledWith(2);
			expect(fixture.healthService.notifyStorageStatusChanged).toHaveBeenCalledOnce();
		} finally {
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

		expect(fixture.blobGcStore.markBlobPendingDeleteIfUnpinned).toHaveBeenCalledWith(
			"missing",
			expect.any(Number),
		);
		expect(fixture.blobStorage.delete).not.toHaveBeenCalled();
		expect(fixture.healthService.notifyStorageStatusChanged).not.toHaveBeenCalled();
	});
});
