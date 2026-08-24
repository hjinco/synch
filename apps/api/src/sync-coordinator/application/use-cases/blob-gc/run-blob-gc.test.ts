import { describe, expect, it, vi } from "vitest";

import { BlobGarbageCollectionService } from "./blob-garbage-collection-service";

function candidate(blobId: string) {
	return {
		blob_id: blobId,
		state: "pending_delete" as const,
		size_bytes: 10,
		created_at: 1,
		last_uploaded_at: 1,
		delete_after: 1,
	};
}

function createFixture(overrides: Partial<Fixture> = {}) {
	const events: string[] = [];
	const fixture: Fixture = {
		vaultStateStore: { readVaultId: vi.fn(() => "vault-1") },
		blobGcStore: {
			expireEntryVersions: vi.fn(),
			listCollectibleBlobs: vi.fn(() => [candidate("blob-1")]),
			readCollectibleBlob: vi.fn(() => null),
			markBlobPendingDeleteIfUnpinned: vi.fn(),
			deleteBlobIfCollectible: vi.fn(() => "deleted" as const),
			nextGcAt: vi.fn(() => 5_000),
		},
		blobStorage: {
			delete: vi.fn(async (key: string) => {
				events.push(`object:${key}`);
			}),
			exists: vi.fn(async () => true),
			deleteByPrefix: vi.fn(async () => {}),
		},
		objectKeyBuilder: {
			blobObjectKey: (vaultId: string, blobId: string) => `${vaultId}/${blobId}`,
			blobObjectKeyPrefix: (vaultId: string) => `${vaultId}/`,
		},
		blobGcScheduler: {
			scheduleAt: vi.fn(async (dueAt: number) => {
				events.push(`schedule:${dueAt}`);
			}),
			scheduleNext: vi.fn(async () => null),
			scheduleNow: vi.fn(async () => {}),
		},
		healthStore: { recordGcCompleted: vi.fn() },
		maintenanceScheduler: { defer: vi.fn(async () => {}) },
		healthSummaryScheduler: { scheduleSummaryFlush: vi.fn(async () => {}) },
		storageStatusNotifier: {
			notifyStorageStatusChanged: vi.fn(),
			dispose: vi.fn(),
		},
		...overrides,
	};

	const useCase = new BlobGarbageCollectionService(
		fixture.vaultStateStore,
		fixture.blobGcStore,
		fixture.blobStorage,
		fixture.objectKeyBuilder,
		fixture.blobGcScheduler,
		fixture.healthStore,
		fixture.maintenanceScheduler,
		fixture.healthSummaryScheduler,
		fixture.storageStatusNotifier,
	);

	return { fixture, useCase, events };
}

type Fixture = {
	vaultStateStore: { readVaultId: MockFn<() => string | null> };
	blobGcStore: {
		expireEntryVersions: MockFn<(now: number) => void>;
		listCollectibleBlobs: MockFn<(now: number, limit: number) => Candidate[]>;
		readCollectibleBlob: MockFn<(blobId: string, now: number) => Candidate | null>;
		markBlobPendingDeleteIfUnpinned: MockFn<(blobId: string, now: number) => void>;
		deleteBlobIfCollectible: MockFn<
			(blobId: string, now: number) => "deleted" | "skipped"
		>;
		nextGcAt: MockFn<(now: number) => number | null>;
	};
	blobStorage: {
		delete: MockFn<(key: string) => Promise<void>>;
		exists: MockFn<(key: string) => Promise<boolean>>;
		deleteByPrefix: MockFn<(prefix: string) => Promise<void>>;
	};
	objectKeyBuilder: {
		blobObjectKey: (vaultId: string, blobId: string) => string;
		blobObjectKeyPrefix: (vaultId: string) => string;
	};
	blobGcScheduler: {
		scheduleAt: MockFn<(dueAt: number, now?: number) => Promise<void>>;
		scheduleNext: MockFn<(now?: number) => Promise<number | null>>;
		scheduleNow: MockFn<(now?: number) => Promise<void>>;
	};
	healthStore: { recordGcCompleted: MockFn<(now?: number) => void> };
	maintenanceScheduler: {
		defer: MockFn<(key: string, dueAt: number, now?: number) => Promise<void>>;
	};
	healthSummaryScheduler: {
		scheduleSummaryFlush: MockFn<(now?: number) => Promise<void>>;
	};
	storageStatusNotifier: {
		notifyStorageStatusChanged: MockFn<() => void>;
		dispose: MockFn<() => void>;
	};
};

type MockFn<T extends (...args: any[]) => any> = ReturnType<typeof vi.fn<T>>;
type Candidate = ReturnType<typeof candidate>;

describe("BlobGarbageCollectionService scheduled GC", () => {
	it("deletes collectible objects before metadata and schedules the next deadline", async () => {
		const { fixture, useCase, events } = createFixture();
		fixture.blobGcStore.deleteBlobIfCollectible.mockImplementation(() => {
			events.push("metadata:blob-1");
			return "deleted";
		});

		await expect(
			useCase.runGc("vault-1", {
				now: 2,
				scheduleHealthFlush: true,
			}),
		).resolves.toBe(5_000);

		expect(events).toEqual([
			"object:vault-1/blob-1",
			"metadata:blob-1",
			"schedule:5000",
		]);
		expect(fixture.blobGcStore.expireEntryVersions).toHaveBeenCalledWith(2);
		expect(fixture.blobGcStore.listCollectibleBlobs).toHaveBeenCalledWith(2, 64);
		expect(fixture.healthStore.recordGcCompleted).toHaveBeenCalledWith(2);
		expect(fixture.maintenanceScheduler.defer).toHaveBeenCalledWith(
			"health_summary_flush",
			2,
			2,
		);
		expect(fixture.storageStatusNotifier.notifyStorageStatusChanged).toHaveBeenCalledOnce();
	});

	it("does not record completion when object deletion fails", async () => {
		const { fixture, useCase } = createFixture({
			blobStorage: {
				delete: vi.fn(async () => {
					throw new Error("object store unavailable");
				}),
				exists: vi.fn(async () => true),
				deleteByPrefix: vi.fn(async () => {}),
			},
		});

		await expect(useCase.runGc("vault-1", { now: 2 })).rejects.toThrow(
			"object store unavailable",
		);
		expect(fixture.blobGcStore.deleteBlobIfCollectible).not.toHaveBeenCalled();
		expect(fixture.healthStore.recordGcCompleted).not.toHaveBeenCalled();
	});

	it("is a no-op when no vault state exists", async () => {
		const { fixture, useCase } = createFixture({
			vaultStateStore: { readVaultId: vi.fn(() => null) },
		});

		await expect(useCase.runGc(undefined, { now: 2 })).resolves.toBeNull();
		expect(fixture.blobGcStore.expireEntryVersions).not.toHaveBeenCalled();
		expect(fixture.blobStorage.delete).not.toHaveBeenCalled();
	});
});
