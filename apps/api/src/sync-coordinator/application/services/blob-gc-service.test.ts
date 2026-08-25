import { describe, expect, it, vi } from "vitest";

import { BlobGcService, GC_BATCH_SIZE } from "./blob-gc-service";
import type {
	BlobGcStore,
	BlobPendingDeleteTransaction,
} from "../ports/outbound";

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
			listCollectibleBlobs: vi.fn(() => [candidate("blob-1"), candidate("blob-2")]),
			readCollectibleBlob: vi.fn(() => null),
			withPendingDeleteTransaction: vi.fn(runPendingDeleteTransaction),
			deleteCollectibleBlobs: vi.fn((blobIds: readonly string[]) => {
				for (const blobId of blobIds) {
					events.push(`metadata:${blobId}`);
				}
				return blobIds.map((blobId) => candidate(blobId));
			}),
			deleteBlobIfCollectible: vi.fn(() => "deleted" as const),
			readGcDeadlines: vi.fn(() => [5_000]),
		},
		blobStorage: {
			delete: vi.fn(async () => {}),
			deleteMany: vi.fn(async (keys: readonly string[]) => {
				for (const key of keys) {
					events.push(`object:${key}`);
				}
				return { failedKeys: [] };
			}),
			exists: vi.fn(async () => true),
			deleteByPrefix: vi.fn(async () => {}),
		},
		objectKeyBuilder: {
			blobObjectKey: (vaultId: string, blobId: string) => `${vaultId}/${blobId}`,
			blobObjectKeyPrefix: (vaultId: string) => `${vaultId}/`,
		},
		healthStore: { recordGcCompleted: vi.fn() },
		maintenanceScheduler: {
			defer: vi.fn(async (key: string, dueAt: number) => {
				if (key === "blob_gc") {
					events.push(`schedule:${dueAt}`);
				}
			}),
		},
		healthService: {
			scheduleSummaryFlush: vi.fn(async () => {}),
			notifyStorageStatusChanged: vi.fn(),
		},
		...overrides,
	};

	const useCase = new BlobGcService(
		fixture.vaultStateStore,
		fixture.blobGcStore as unknown as BlobGcStore,
		fixture.blobStorage,
		fixture.objectKeyBuilder,
		fixture.healthStore,
		fixture.maintenanceScheduler,
		fixture.healthService,
	);

	return { fixture, useCase, events };
}

type Fixture = {
	vaultStateStore: { readVaultId: MockFn<() => string | null> };
	blobGcStore: {
		expireEntryVersions: MockFn<(now: number) => void>;
		listCollectibleBlobs: MockFn<(now: number, limit: number) => Candidate[]>;
		readCollectibleBlob: MockFn<(blobId: string, now: number) => Candidate | null>;
		withPendingDeleteTransaction: MockFn<
			(
				blobId: string,
				now: number,
				operation: (transaction: BlobPendingDeleteTransaction) => void,
			) => void
		>;
		deleteCollectibleBlobs: MockFn<(blobIds: readonly string[], now: number) => Candidate[]>;
		deleteBlobIfCollectible: MockFn<
			(blobId: string, now: number) => "deleted" | "skipped"
		>;
		readGcDeadlines: MockFn<(now: number) => readonly number[]>;
	};
	blobStorage: {
		delete: MockFn<(key: string) => Promise<void>>;
		deleteMany: MockFn<
			(keys: readonly string[]) => Promise<{ failedKeys: readonly string[] }>
		>;
		exists: MockFn<(key: string) => Promise<boolean>>;
		deleteByPrefix: MockFn<(prefix: string) => Promise<void>>;
	};
	objectKeyBuilder: {
		blobObjectKey: (vaultId: string, blobId: string) => string;
		blobObjectKeyPrefix: (vaultId: string) => string;
	};
	healthStore: { recordGcCompleted: MockFn<(now?: number) => void> };
	maintenanceScheduler: {
		defer: MockFn<(key: string, dueAt: number, now?: number) => Promise<void>>;
	};
	healthService: {
		scheduleSummaryFlush: MockFn<(now?: number) => Promise<void>>;
		notifyStorageStatusChanged: MockFn<() => void>;
	};
};

type MockFn<T extends (...args: any[]) => any> = ReturnType<typeof vi.fn<T>>;
type Candidate = ReturnType<typeof candidate>;

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

describe("BlobGcService scheduled GC", () => {
	it("deletes collectible objects in one batch before sqlite rows", async () => {
		const { fixture, useCase, events } = createFixture();

		await expect(
			useCase.runGc("vault-1", {
				now: 2,
				scheduleHealthFlush: true,
			}),
		).resolves.toBe(5_000);

		expect(events).toEqual([
			"object:vault-1/blob-1",
			"object:vault-1/blob-2",
			"metadata:blob-1",
			"metadata:blob-2",
			"schedule:5000",
		]);
		expect(fixture.blobStorage.deleteMany).toHaveBeenCalledWith([
			"vault-1/blob-1",
			"vault-1/blob-2",
		]);
		expect(fixture.blobGcStore.deleteCollectibleBlobs).toHaveBeenCalledWith(
			["blob-1", "blob-2"],
			2,
		);
		expect(fixture.blobStorage.delete).not.toHaveBeenCalled();
		expect(fixture.blobGcStore.expireEntryVersions).toHaveBeenCalledWith(2);
		expect(fixture.blobGcStore.listCollectibleBlobs).toHaveBeenCalledWith(
			2,
			GC_BATCH_SIZE,
		);
		expect(fixture.healthStore.recordGcCompleted).toHaveBeenCalledWith(2);
		expect(fixture.maintenanceScheduler.defer).toHaveBeenCalledWith(
			"health_summary_flush",
			2,
			2,
		);
		expect(fixture.healthService.notifyStorageStatusChanged).toHaveBeenCalledOnce();
	});

	it("does not delete sqlite rows when object deletion fails", async () => {
		const { fixture, useCase } = createFixture({
			blobStorage: {
				delete: vi.fn(async () => {}),
				deleteMany: vi.fn(async () => {
					throw new Error("object store unavailable");
				}),
				exists: vi.fn(async () => true),
				deleteByPrefix: vi.fn(async () => {}),
			},
		});

		await expect(useCase.runGc("vault-1", { now: 2 })).rejects.toThrow(
			"object store unavailable",
		);
		expect(fixture.blobGcStore.deleteCollectibleBlobs).not.toHaveBeenCalled();
		expect(fixture.healthStore.recordGcCompleted).not.toHaveBeenCalled();
		expect(fixture.healthService.notifyStorageStatusChanged).not.toHaveBeenCalled();
	});

	it("deletes sqlite rows for objects that succeeded when a batch is partial", async () => {
		const { fixture, useCase } = createFixture({
			blobStorage: {
				delete: vi.fn(async () => {}),
				deleteMany: vi.fn(async () => ({ failedKeys: ["vault-1/blob-2"] })),
				exists: vi.fn(async () => true),
				deleteByPrefix: vi.fn(async () => {}),
			},
		});

		await expect(useCase.runGc("vault-1", { now: 2 })).rejects.toMatchObject({
			name: "BlobObjectBatchDeleteError",
			deletedCount: 1,
			failedKeys: ["vault-1/blob-2"],
		});
		expect(fixture.blobGcStore.deleteCollectibleBlobs).toHaveBeenCalledWith(
			["blob-1"],
			2,
		);
		expect(fixture.healthStore.recordGcCompleted).not.toHaveBeenCalled();
		expect(fixture.healthService.notifyStorageStatusChanged).toHaveBeenCalledOnce();
		expect(fixture.maintenanceScheduler.defer).not.toHaveBeenCalled();
	});

	it("is a no-op when no vault state exists", async () => {
		const { fixture, useCase } = createFixture({
			vaultStateStore: { readVaultId: vi.fn(() => null) },
		});

		await expect(useCase.runGc(undefined, { now: 2 })).resolves.toBeNull();
		expect(fixture.blobGcStore.expireEntryVersions).not.toHaveBeenCalled();
		expect(fixture.blobGcStore.deleteCollectibleBlobs).not.toHaveBeenCalled();
		expect(fixture.blobStorage.deleteMany).not.toHaveBeenCalled();
	});
});
