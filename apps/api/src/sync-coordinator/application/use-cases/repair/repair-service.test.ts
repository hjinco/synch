import { afterEach, describe, expect, it, vi } from "vitest";

import { CoordinatorSyncRepairService } from "./repair-service";
import { stageBlobForTest } from "../../../test-helpers";
import {
	closeAllTestSqliteCoordinators,
	createSqliteCoordinator,
} from "../../../adapters/outbound/sqlite/test-helpers";
import { STAGED_BLOB_STALE_MS } from "../../../domain/health-policy";

const objectKeyBuilder = {
	blobObjectKey: (vaultId: string, blobId: string) => `${vaultId}/${blobId}`,
	blobObjectKeyPrefix: (vaultId: string) => `${vaultId}/`,
};

afterEach(() => {
	closeAllTestSqliteCoordinators();
});

describe("CoordinatorSyncRepairService", () => {
	it("removes unreferenced stale staged blobs and clears the pause", async () => {
		const { blobStore, cursorStore, handle } = await createSqliteCoordinator();
		const now = Date.now();
		stageBlobForTest(
			blobStore,
			"blob-stale",
			100,
			now - STAGED_BLOB_STALE_MS - 1,
			now - 1,
		);
		handle.exec(
			"UPDATE coordinator_state SET sync_paused_at = ?, sync_pause_reason = ? WHERE id = 1",
			now - 1,
			"staged blob blob-stale remained staged for at least one hour",
		);
		const blobStorage = {
			exists: vi.fn(async () => true),
			delete: vi.fn(async () => {}),
			deleteByPrefix: vi.fn(async () => {}),
		};
		const maintenanceScheduler = { defer: vi.fn(async () => {}) };

		const service = new CoordinatorSyncRepairService(
			blobStore,
			cursorStore,
			blobStorage,
			objectKeyBuilder,
			maintenanceScheduler,
		);

		const result = await service.repairSyncState("vault-1");

		expect(result).toMatchObject({
			status: "repaired",
			deletedStagedBlobCount: 1,
			remainingStaleStagedBlobCount: 0,
			pause: null,
		});
		expect(blobStorage.delete).toHaveBeenCalledWith("vault-1/blob-stale");
		expect(blobStore.readBlob("blob-stale")).toBeNull();
		expect(cursorStore.readSyncPause()).toBeNull();
		expect(maintenanceScheduler.defer).toHaveBeenCalledWith(
			"blob_gc",
			expect.any(Number),
			expect.any(Number),
		);
	});

	it("keeps a paused vault when a stale blob is still referenced", async () => {
		const { blobStore, cursorStore, handle } = await createSqliteCoordinator();
		const now = Date.now();
		stageBlobForTest(
			blobStore,
			"blob-referenced",
			100,
			now - STAGED_BLOB_STALE_MS - 1,
			now - 1,
		);
		handle.exec(
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
		handle.exec(
			"UPDATE coordinator_state SET sync_paused_at = ?, sync_pause_reason = ? WHERE id = 1",
			now - 1,
			"staged blob blob-referenced remained staged for at least one hour",
		);
		const blobStorage = {
			exists: vi.fn(async () => true),
			delete: vi.fn(async () => {}),
			deleteByPrefix: vi.fn(async () => {}),
		};
		const maintenanceScheduler = { defer: vi.fn(async () => {}) };

		const service = new CoordinatorSyncRepairService(
			blobStore,
			cursorStore,
			blobStorage,
			objectKeyBuilder,
			maintenanceScheduler,
		);

		const result = await service.repairSyncState("vault-1");

		expect(result).toMatchObject({
			status: "manual_repair_required",
			issue: "referenced_staged_blob",
			remainingStaleStagedBlobCount: 1,
		});
		expect(blobStorage.delete).not.toHaveBeenCalled();
		expect(cursorStore.readSyncPause()).not.toBeNull();
	});

	it("clears a stale-blob pause when the staged row is already gone", async () => {
		const { blobStore, cursorStore, handle } = await createSqliteCoordinator();
		const now = Date.now();
		handle.exec(
			"UPDATE coordinator_state SET sync_paused_at = ?, sync_pause_reason = ? WHERE id = 1",
			now - 1,
			"staged blob blob-gone remained staged for at least one hour",
		);
		const blobStorage = {
			exists: vi.fn(async () => true),
			delete: vi.fn(async () => {}),
			deleteByPrefix: vi.fn(async () => {}),
		};
		const maintenanceScheduler = { defer: vi.fn(async () => {}) };

		const result = await new CoordinatorSyncRepairService(
			blobStore,
			cursorStore,
			blobStorage,
			objectKeyBuilder,
			maintenanceScheduler,
		).repairSyncState("vault-1");

		expect(result).toMatchObject({
			status: "repaired",
			deletedStagedBlobCount: 0,
			remainingStaleStagedBlobCount: 0,
			pause: null,
		});
		expect(blobStorage.delete).not.toHaveBeenCalled();
		expect(cursorStore.readSyncPause()).toBeNull();
	});

	it("keeps the pause when object deletion fails after the staged row is dropped", async () => {
		const { blobStore, cursorStore, handle, healthStore } =
			await createSqliteCoordinator();
		const now = Date.now();
		stageBlobForTest(
			blobStore,
			"blob-stale",
			100,
			now - STAGED_BLOB_STALE_MS - 1,
			now - 1,
		);
		handle.exec(
			"UPDATE coordinator_state SET sync_paused_at = ?, sync_pause_reason = ? WHERE id = 1",
			now - 1,
			"staged blob blob-stale remained staged for at least one hour",
		);
		const blobStorage = {
			exists: vi.fn(async () => true),
			delete: vi.fn(async () => {
				throw new Error("object store unavailable");
			}),
			deleteByPrefix: vi.fn(async () => {}),
		};
		const maintenanceScheduler = { defer: vi.fn(async () => {}) };

		const result = await new CoordinatorSyncRepairService(
			blobStore,
			cursorStore,
			blobStorage,
			objectKeyBuilder,
			maintenanceScheduler,
		).repairSyncState("vault-1");

		expect(result).toMatchObject({
			status: "manual_repair_required",
			issue: "blob_storage_delete_failed",
			deletedStagedBlobCount: 0,
			remainingStaleStagedBlobCount: 0,
		});
		expect(blobStore.readBlob("blob-stale")).toBeNull();
		expect(healthStore.readStorageStatus().storageUsedBytes).toBe(0);
		expect(cursorStore.readSyncPause()).not.toBeNull();
	});
});
