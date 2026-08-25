import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_REPAIRABLE_STALE_STAGED_BLOBS, VaultService } from "./vault-service";
import { stageBlobForTest } from "../../test-helpers";
import {
	closeAllTestSqliteCoordinators,
	createSqliteCoordinator,
} from "../../adapters/outbound/sqlite/test-helpers";
import { STAGED_BLOB_STALE_MS } from "../../domain/health-policy";
import type { BlobObjectRepository } from "../ports/outbound";

const objectKeyBuilder = {
	blobObjectKey: (vaultId: string, blobId: string) => `${vaultId}/${blobId}`,
	blobObjectKeyPrefix: (vaultId: string) => `${vaultId}/`,
};

afterEach(() => {
	closeAllTestSqliteCoordinators();
});

describe("VaultService sync repair", () => {
	it("removes unreferenced stale staged blobs and clears the pause", async () => {
		const sqlite = await createSqliteCoordinator();
		const now = Date.now();
		stageBlobForTest(
			sqlite.blobStore,
			"blob-stale",
			100,
			now - STAGED_BLOB_STALE_MS - 1,
			now - 1,
		);
		sqlite.handle.exec(
			"UPDATE coordinator_state SET sync_paused_at = ?, sync_pause_reason = ? WHERE id = 1",
			now - 1,
			"staged blob blob-stale remained staged for at least one hour",
		);
		const blobStorage = createBlobStorage();
		const blobGcService = {
			scheduleNow: vi.fn(async () => {}),
			readNextGcAt: vi.fn(() => null),
		};
		const service = createVaultService(sqlite, blobStorage, blobGcService);

		const result = await service.repairSyncState("vault-1");

		expect(result).toMatchObject({
			status: "repaired",
			deletedStagedBlobCount: 1,
			remainingStaleStagedBlobCount: 0,
			pause: null,
		});
		expect(blobStorage.delete).toHaveBeenCalledWith("vault-1/blob-stale");
		expect(sqlite.blobStore.readBlob("blob-stale")).toBeNull();
		expect(sqlite.cursorStore.readSyncPause()).toBeNull();
		expect(blobGcService.scheduleNow).toHaveBeenCalledWith(expect.any(Number));
	});

	it("keeps a paused vault when a stale blob is still referenced", async () => {
		const sqlite = await createSqliteCoordinator();
		const now = Date.now();
		stageBlobForTest(
			sqlite.blobStore,
			"blob-referenced",
			100,
			now - STAGED_BLOB_STALE_MS - 1,
			now - 1,
		);
		sqlite.handle.exec(
			`
			INSERT INTO entries (
				entry_id, revision, blob_id, encrypted_metadata, deleted,
				updated_seq, updated_at, updated_by_user_id,
				updated_by_local_vault_id, last_mutation_id
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`,
			"entry-1",
			1,
			"blob-referenced",
			"metadata",
			0,
			1,
			now,
			"user-1",
			"local-1",
			"mutation-1",
		);
		sqlite.handle.exec(
			"UPDATE coordinator_state SET sync_paused_at = ?, sync_pause_reason = ? WHERE id = 1",
			now - 1,
			"staged blob blob-referenced remained staged for at least one hour",
		);
		const blobStorage = createBlobStorage();
		const service = createVaultService(sqlite, blobStorage);

		const result = await service.repairSyncState("vault-1");

		expect(result).toMatchObject({
			status: "manual_repair_required",
			issue: "referenced_staged_blob",
			remainingStaleStagedBlobCount: 1,
		});
		expect(blobStorage.delete).not.toHaveBeenCalled();
		expect(sqlite.cursorStore.readSyncPause()).not.toBeNull();
	});

	it("clears a stale-blob pause when the staged row is already gone", async () => {
		const sqlite = await createSqliteCoordinator();
		const now = Date.now();
		sqlite.handle.exec(
			"UPDATE coordinator_state SET sync_paused_at = ?, sync_pause_reason = ? WHERE id = 1",
			now - 1,
			"staged blob blob-gone remained staged for at least one hour",
		);
		const blobStorage = createBlobStorage();

		const result = await createVaultService(sqlite, blobStorage).repairSyncState("vault-1");

		expect(result).toMatchObject({
			status: "repaired",
			deletedStagedBlobCount: 0,
			remainingStaleStagedBlobCount: 0,
			pause: null,
		});
		expect(blobStorage.delete).not.toHaveBeenCalled();
		expect(sqlite.cursorStore.readSyncPause()).toBeNull();
	});

	it("keeps the pause when object deletion fails after the staged row is dropped", async () => {
		const sqlite = await createSqliteCoordinator();
		const now = Date.now();
		stageBlobForTest(
			sqlite.blobStore,
			"blob-stale",
			100,
			now - STAGED_BLOB_STALE_MS - 1,
			now - 1,
		);
		sqlite.handle.exec(
			"UPDATE coordinator_state SET sync_paused_at = ?, sync_pause_reason = ? WHERE id = 1",
			now - 1,
			"staged blob blob-stale remained staged for at least one hour",
		);
		const blobStorage = createBlobStorage({
			delete: vi.fn(async () => {
				throw new Error("object store unavailable");
			}),
		});

		const result = await createVaultService(sqlite, blobStorage).repairSyncState("vault-1");

		expect(result).toMatchObject({
			status: "manual_repair_required",
			issue: "blob_storage_delete_failed",
			deletedStagedBlobCount: 0,
			remainingStaleStagedBlobCount: 0,
		});
		expect(sqlite.blobStore.readBlob("blob-stale")).toBeNull();
		expect(sqlite.healthStore.readStorageStatus().storageUsedBytes).toBe(0);
		expect(sqlite.cursorStore.readSyncPause()).not.toBeNull();
	});

	it("returns not_paused when vault state does not exist", async () => {
		const sqlite = await createSqliteCoordinator();
		vi.spyOn(sqlite.cursorStore, "vaultStateExistsFor").mockReturnValue(false);
		const blobStorage = createBlobStorage();

		const result = await createVaultService(sqlite, blobStorage).repairSyncState("vault-1");

		expect(result).toMatchObject({
			status: "not_paused",
			deletedStagedBlobCount: 0,
			remainingStaleStagedBlobCount: 0,
			nextGcAt: null,
			pause: null,
		});
		expect(result.issue).toBeUndefined();
		expect(blobStorage.delete).not.toHaveBeenCalled();
	});

	it("keeps an unsupported pause reason without deleting staged blobs", async () => {
		const sqlite = await createSqliteCoordinator();
		const now = Date.now();
		stageBlobForTest(
			sqlite.blobStore,
			"blob-stale",
			100,
			now - STAGED_BLOB_STALE_MS - 1,
			now - 1,
		);
		sqlite.handle.exec(
			"UPDATE coordinator_state SET sync_paused_at = ?, sync_pause_reason = ? WHERE id = 1",
			now - 1,
			"manual operator hold",
		);
		const blobStorage = createBlobStorage();

		const result = await createVaultService(sqlite, blobStorage).repairSyncState("vault-1");

		expect(result).toMatchObject({
			status: "manual_repair_required",
			issue: "unsupported_pause_reason",
			deletedStagedBlobCount: 0,
			remainingStaleStagedBlobCount: 1,
			nextGcAt: null,
			pause: {
				pausedAt: now - 1,
				reason: "manual operator hold",
			},
		});
		expect(blobStorage.delete).not.toHaveBeenCalled();
		expect(sqlite.blobStore.readBlob("blob-stale")).not.toBeNull();
		expect(sqlite.cursorStore.readSyncPause()).toMatchObject({
			reason: "manual operator hold",
		});
	});

	it("refuses repair when stale staged blobs exceed the repairable batch", async () => {
		const sqlite = await createSqliteCoordinator();
		const now = Date.now();
		const staleCount = MAX_REPAIRABLE_STALE_STAGED_BLOBS + 1;
		for (let index = 0; index < staleCount; index += 1) {
			stageBlobForTest(
				sqlite.blobStore,
				`blob-stale-${index}`,
				100,
				now - STAGED_BLOB_STALE_MS - 1,
				now - 1,
			);
		}
		sqlite.handle.exec(
			"UPDATE coordinator_state SET sync_paused_at = ?, sync_pause_reason = ? WHERE id = 1",
			now - 1,
			"staged blob blob-stale-0 remained staged for at least one hour",
		);
		const blobStorage = createBlobStorage();

		const result = await createVaultService(sqlite, blobStorage).repairSyncState("vault-1");

		expect(result).toMatchObject({
			status: "manual_repair_required",
			issue: "repair_limit_exceeded",
			deletedStagedBlobCount: 0,
			remainingStaleStagedBlobCount: staleCount,
			nextGcAt: null,
		});
		expect(blobStorage.delete).not.toHaveBeenCalled();
		expect(sqlite.cursorStore.readSyncPause()).not.toBeNull();
		expect(sqlite.blobStore.readBlob("blob-stale-0")).not.toBeNull();
	});
});

function createBlobStorage(
	overrides: Partial<BlobObjectRepository> = {},
): BlobObjectRepository {
	return {
		exists: vi.fn(async () => true),
		delete: vi.fn(async () => {}),
		deleteMany: vi.fn(async () => ({ failedKeys: [] })),
		deleteByPrefix: vi.fn(async () => {}),
		...overrides,
	};
}

function createVaultService(
	sqlite: Awaited<ReturnType<typeof createSqliteCoordinator>>,
	blobStorage: BlobObjectRepository,
	blobGcService: {
		scheduleNow: (now?: number) => Promise<void>;
		readNextGcAt: (now?: number) => number | null;
	} = {
		scheduleNow: vi.fn(async () => {}),
		readNextGcAt: vi.fn(() => null),
	},
) {
	return new VaultService(
		sqlite.lifecycle,
		sqlite.cursorStore,
		sqlite.healthStore,
		{
			broadcastPolicyUpdated: vi.fn(),
			closeAllSockets: vi.fn(),
		},
		blobStorage,
		objectKeyBuilder,
		{
			readInitialVaultLimits: async () => {
				throw new Error("initial vault limit reader is not used by repair");
			},
		},
		{ scheduleSummaryFlush: async () => {} },
		sqlite.staleStagedBlobStore,
		blobGcService,
	);
}
