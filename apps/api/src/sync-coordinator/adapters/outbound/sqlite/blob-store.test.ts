import { afterEach, describe, expect, it } from "vitest";

import { SyncCoordinatorApplicationError } from "../../../application/errors/coordinator-errors";
import { stageBlobForTest } from "../../../test-helpers";
import { CoordinatorBlobStore } from "./blob-store";
import {
	closeAllTestSqliteCoordinators,
	createSqliteCoordinator,
	testSession,
} from "./test-helpers";

afterEach(() => {
	closeAllTestSqliteCoordinators();
});

describe("sqlite backend: blob staging", () => {
	it("stages a blob and increments storage used bytes", async () => {
		const { blobStore, healthStore } = await createSqliteCoordinator();

		await stage(blobStore, "blob-1", 1_000, 100, 200);

		expect(blobStore.readBlob("blob-1")).toMatchObject({
			blob_id: "blob-1",
			state: "staged",
			size_bytes: 1_000,
		});
		expect(healthStore.readStorageStatus().storageUsedBytes).toBe(1_000);
	});

	it("atomically pauses sync when a stale staged blob is retried", async () => {
		const { blobStore, cursorStore } = await createSqliteCoordinator();
		await stage(blobStore, "blob-stale", 1_000, 100, 200);

		const retriedAt = 100 + 60 * 60 * 1000;
		await expect(
			stage(blobStore, "blob-stale", 1_000, retriedAt, retriedAt + 100),
		).resolves.toEqual({
			status: "sync_paused",
		});
		expect(cursorStore.readSyncPause()).toMatchObject({
			pausedAt: retriedAt,
			reason: expect.stringContaining("blob-stale"),
		});
		expect(blobStore.readBlob("blob-stale")).toMatchObject({
			created_at: 100,
			last_uploaded_at: 100,
			delete_after: 200,
		});
	});

	it("rejects a blob larger than the configured max file size", async () => {
		const { blobStore } = await createSqliteCoordinator("vault-1", {
			storageLimitBytes: 1_000_000_000,
			maxFileSizeBytes: 10,
			versionHistoryRetentionDays: 1,
		});

		await expect(stage(blobStore, "blob-1", 11, 100, 200)).rejects.toThrow(
			SyncCoordinatorApplicationError,
		);
	});

	it("rejects a blob that would exceed the vault storage quota", async () => {
		const { blobStore } = await createSqliteCoordinator("vault-1", {
			storageLimitBytes: 1_000,
			maxFileSizeBytes: 10_000_000,
			versionHistoryRetentionDays: 1,
		});

		await expect(stage(blobStore, "blob-1", 2_000, 100, 200)).rejects.toThrow(
			SyncCoordinatorApplicationError,
		);
	});

	it("does not mutate storage_used_bytes when a stage is rejected mid-transaction", async () => {
		const { blobStore, healthStore } = await createSqliteCoordinator("vault-1", {
			storageLimitBytes: 1_000,
			maxFileSizeBytes: 10_000_000,
			versionHistoryRetentionDays: 1,
		});

		await stage(blobStore, "blob-a", 500, 100, 200);
		expect(healthStore.readStorageStatus().storageUsedBytes).toBe(500);

		await expect(stage(blobStore, "blob-b", 900, 100, 200)).rejects.toThrow(
			SyncCoordinatorApplicationError,
		);

		// The rejected stage must not have partially applied: no leftover blob
		// row, and the quota counter must reflect only the first, successful
		// stage. This is the transactional invariant the DO model gets for
		// free from `this.getDb().transaction(...)`; better-sqlite3's sync
		// transaction must roll back the same way on a thrown error.
		expect(blobStore.readBlob("blob-b")).toBeNull();
		expect(healthStore.readStorageStatus().storageUsedBytes).toBe(500);
	});

	it("rejects re-staging a blob that is already live", async () => {
		const { blobStore, mutationStore } = await createSqliteCoordinator();
		await stage(blobStore, "blob-1", 100, 1_000, 2_000);
		await mutationStore.commitMutations(
			testSession(),
			{
				type: "commit_mutations",
				requestId: "req-1",
				mutations: [
					{
						mutationId: "m1",
						entryId: "entry-1",
						op: "upsert",
						baseRevision: 0,
						blobId: "blob-1",
						encryptedMetadata: "ciphertext",
					},
				],
			},
			30 * 60 * 1000,
			24 * 60 * 60 * 1000,
		);

		expect(blobStore.readBlob("blob-1")?.state).toBe("live");
		await expect(stage(blobStore, "blob-1", 100, 3_000, 4_000)).rejects.toThrow(
			SyncCoordinatorApplicationError,
		);
	});

	it("collects a staged-but-never-committed blob once its grace period passes", async () => {
		const { blobStore } = await createSqliteCoordinator();
		await stage(blobStore, "blob-1", 100, 1_000, 1_500);

		const ready = blobStore.listBlobsReadyForDeletion(2_000, 10);
		expect(ready.map((row) => row.blob_id)).toContain("blob-1");

		blobStore.deleteBlobIfCollectible("blob-1", 2_000);
		expect(blobStore.readBlob("blob-1")).toBeNull();
	});

	it("deletes an unreferenced staged blob and reports a missing row", async () => {
		const { blobStore, healthStore } = await createSqliteCoordinator();
		await stage(blobStore, "blob-1", 100, 1_000, 2_000);

		expect(blobStore.deleteUnreferencedStagedBlob("blob-1", 1_500)).toBe("deleted");
		expect(blobStore.readBlob("blob-1")).toBeNull();
		expect(healthStore.readStorageStatus().storageUsedBytes).toBe(0);
		expect(blobStore.deleteUnreferencedStagedBlob("blob-1", 1_500)).toBe("missing");
	});

	it("does not delete a staged blob that is still referenced", async () => {
		const { blobStore, handle, healthStore } = await createSqliteCoordinator();
		await stage(blobStore, "blob-1", 100, 1_000, 2_000);
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
			"blob-1",
			"metadata",
			0,
			1,
			1_000,
			"user-1",
			"local-1",
			"mutation-1",
		);

		expect(blobStore.deleteUnreferencedStagedBlob("blob-1", 1_500)).toBe(
			"referenced",
		);
		expect(blobStore.readBlob("blob-1")).toMatchObject({
			blob_id: "blob-1",
			state: "staged",
		});
		expect(healthStore.readStorageStatus().storageUsedBytes).toBe(100);
	});

	it("marks a live blob pending-delete once its entry stops referencing it", async () => {
		const { blobStore, mutationStore } = await createSqliteCoordinator();
		await stage(blobStore, "blob-1", 100, 1_000, 2_000);
		await mutationStore.commitMutations(
			testSession(),
			{
				type: "commit_mutations",
				requestId: "req-live",
				mutations: [
					{
						mutationId: "m-live",
						entryId: "entry-1",
						op: "upsert",
						baseRevision: 0,
						blobId: "blob-1",
						encryptedMetadata: "ciphertext",
					},
				],
			},
			30 * 60 * 1000,
			24 * 60 * 60 * 1000,
		);
		expect(blobStore.readBlob("blob-1")?.state).toBe("live");

		await mutationStore.commitMutations(
			testSession(),
			{
				type: "commit_mutations",
				requestId: "req-dereference",
				mutations: [
					{
						mutationId: "m-delete",
						entryId: "entry-1",
						op: "delete",
						baseRevision: 1,
						blobId: null,
						encryptedMetadata: "",
					},
				],
			},
			30 * 60 * 1000,
			24 * 60 * 60 * 1000,
		);

		expect(blobStore.readBlob("blob-1")?.state).toBe("pending_delete");
	});
});

async function stage(
	blobStore: CoordinatorBlobStore,
	blobId: string,
	sizeBytes: number,
	now: number,
	deleteAfter: number,
) {
	return stageBlobForTest(blobStore, blobId, sizeBytes, now, deleteAfter);
}
