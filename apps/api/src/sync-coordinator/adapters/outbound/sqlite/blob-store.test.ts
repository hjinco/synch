import { afterEach, describe, expect, it } from "vitest";

import { SyncCoordinatorApplicationError } from "../../../application/errors/coordinator-errors";
import { GC_BATCH_SIZE } from "../../../application/services/blob-gc-service";
import {
	decidePendingDelete,
	earliestGcDeadline,
	isBlobPinned,
} from "../../../domain/blob-gc-policy";
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
		);

		expect(blobStore.readBlob("blob-1")?.state).toBe("live");
		await expect(stage(blobStore, "blob-1", 100, 3_000, 4_000)).rejects.toThrow(
			SyncCoordinatorApplicationError,
		);
	});

	it("collects a staged-but-never-committed blob once its grace period passes", async () => {
		const { blobStore, blobGcStore } = await createSqliteCoordinator();
		await stage(blobStore, "blob-1", 100, 1_000, 1_500);

		blobGcStore.expireEntryVersions(2_000);
		const ready = blobGcStore.listCollectibleBlobs(2_000, 10);
		expect(ready.map((row) => row.blob_id)).toContain("blob-1");

		blobGcStore.deleteBlobIfCollectible("blob-1", 2_000);
		expect(blobStore.readBlob("blob-1")).toBeNull();
	});

	it("deletes a collectible batch in one statement and skips referenced blobs", async () => {
		const { blobStore, blobGcStore, handle, healthStore } =
			await createSqliteCoordinator();
		await stage(blobStore, "blob-a", 100, 1_000, 1_500);
		await stage(blobStore, "blob-b", 50, 1_000, 1_500);
		await stage(blobStore, "blob-referenced", 25, 1_000, 1_500);
		handle.exec(
			`
			INSERT INTO entries (
				entry_id, revision, blob_id, encrypted_metadata, deleted,
				updated_seq, updated_at, updated_by_user_id,
				updated_by_local_vault_id, last_mutation_id
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`,
			"entry-referenced",
			1,
			"blob-referenced",
			"metadata",
			0,
			1,
			1_000,
			"user-1",
			"local-1",
			"mutation-1",
		);

		expect(
			blobGcStore
				.deleteCollectibleBlobs(["blob-a", "blob-b", "blob-referenced"], 2_000)
				.map((blob) => blob.blob_id)
				.sort(),
		).toEqual(["blob-a", "blob-b"]);
		expect(blobStore.readBlob("blob-a")).toBeNull();
		expect(blobStore.readBlob("blob-b")).toBeNull();
		expect(blobStore.readBlob("blob-referenced")?.state).toBe("staged");
		expect(healthStore.readStorageStatus().storageUsedBytes).toBe(25);
	});

	it("deletes more collectible blobs than the durable object parameter limit allows", async () => {
		const { blobStore, blobGcStore, healthStore } = await createSqliteCoordinator();
		const blobIds = Array.from({ length: 101 }, (_, index) => `blob-${index}`);
		for (const blobId of blobIds) {
			await stage(blobStore, blobId, 1, 1_000, 1_500);
		}

		expect(
			blobGcStore.deleteCollectibleBlobs(blobIds, 2_000).map((blob) => blob.blob_id).sort(),
		).toEqual([...blobIds].sort());
		expect(blobIds.every((blobId) => blobStore.readBlob(blobId) === null)).toBe(true);
		expect(healthStore.readStorageStatus().storageUsedBytes).toBe(0);
	});

	it("deletes an unreferenced staged blob and reports a missing row", async () => {
		const { blobStore, healthStore, staleStagedBlobStore } = await createSqliteCoordinator();
		await stage(blobStore, "blob-1", 100, 1_000, 2_000);

		expect(deleteUnreferencedStagedBlob(staleStagedBlobStore, "blob-1", 1_500)).toBe(
			"deleted",
		);
		expect(blobStore.readBlob("blob-1")).toBeNull();
		expect(healthStore.readStorageStatus().storageUsedBytes).toBe(0);
		expect(deleteUnreferencedStagedBlob(staleStagedBlobStore, "blob-1", 1_500)).toBe(
			"missing",
		);
	});

	it("does not delete a staged blob that is still referenced", async () => {
		const { blobStore, staleStagedBlobStore, handle, healthStore } =
			await createSqliteCoordinator();
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

		expect(deleteUnreferencedStagedBlob(staleStagedBlobStore, "blob-1", 1_500)).toBe(
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
		);

		expect(blobStore.readBlob("blob-1")?.state).toBe("pending_delete");
	});

	it("marks an unreferenced live blob pending-delete through the GC store", async () => {
		const { blobStore, blobGcStore, handle } = await createSqliteCoordinator();
		await stage(blobStore, "blob-1", 100, 1_000, 2_000);
		handle.exec(
			"UPDATE blobs SET state = ?, delete_after = NULL WHERE blob_id = ?",
			"live",
			"blob-1",
		);

		markBlobPendingDeleteIfUnpinned(blobGcStore, "blob-1", 3_000);

		expect(blobStore.readBlob("blob-1")).toMatchObject({
			state: "pending_delete",
			delete_after: 3_000,
		});
	});

	it("keeps a blob collectible only after retained history expires", async () => {
		const { blobStore, blobGcStore, handle } = await createSqliteCoordinator();
		await stage(blobStore, "blob-history", 100, 1_000, 1_500);
		handle.exec(
			"UPDATE blobs SET state = ?, delete_after = ? WHERE blob_id = ?",
			"pending_delete",
			1_500,
			"blob-history",
		);
		handle.exec(
			`
			INSERT INTO entry_versions (
				version_id, entry_id, source_revision, op_type, blob_id,
				encrypted_metadata, reason, bucket_start_ms, captured_at,
				expires_at, created_by_user_id, created_by_local_vault_id
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`,
			"version-1",
			"entry-1",
			1,
			"upsert",
			"blob-history",
			"metadata",
			"auto",
			null,
			1_000,
			3_000,
			"user-1",
			"local-1",
		);

		blobGcStore.expireEntryVersions(2_000);
		expect(blobGcStore.readCollectibleBlob("blob-history", 2_000)).toBeNull();

		blobGcStore.expireEntryVersions(3_000);
		expect(blobGcStore.readCollectibleBlob("blob-history", 3_000)).toMatchObject({
			blob_id: "blob-history",
		});
	});

	it("returns the earliest future GC deadline", async () => {
		const { blobStore, blobGcStore } = await createSqliteCoordinator();
		await stage(blobStore, "blob-deadline", 100, 1_000, 5_000);

		expect(earliestGcDeadline(blobGcStore.readGcDeadlines(2_000), 2_000)).toBe(5_000);
		expect(earliestGcDeadline(blobGcStore.readGcDeadlines(5_000), 5_000)).toBe(5_000);
		blobGcStore.deleteBlobIfCollectible("blob-deadline", 5_000);
		expect(earliestGcDeadline(blobGcStore.readGcDeadlines(5_000), 5_000)).toBeNull();
	});

	it("keeps due GC work scheduled after the first deletion batch", async () => {
		const { blobStore, blobGcStore } = await createSqliteCoordinator();
		for (let i = 0; i < GC_BATCH_SIZE + 1; i += 1) {
			await stage(blobStore, `blob-${i}`, 1, 1_000, 1_500);
		}

		const firstBatch = blobGcStore.listCollectibleBlobs(2_000, GC_BATCH_SIZE);
		expect(firstBatch).toHaveLength(GC_BATCH_SIZE);
		expect(
			blobGcStore.deleteCollectibleBlobs(
				firstBatch.map((blob) => blob.blob_id),
				2_000,
			),
		).toHaveLength(GC_BATCH_SIZE);

		expect(earliestGcDeadline(blobGcStore.readGcDeadlines(2_000), 2_000)).toBe(2_000);
	});

	it("does not keep scheduling a due staged blob that is referenced", async () => {
		const { blobStore, blobGcStore, handle } = await createSqliteCoordinator();
		await stage(blobStore, "blob-referenced-due", 100, 1_000, 1_500);
		handle.exec(
			`
			INSERT INTO entries (
				entry_id, revision, blob_id, encrypted_metadata, deleted,
				updated_seq, updated_at, updated_by_user_id,
				updated_by_local_vault_id, last_mutation_id
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`,
			"entry-referenced-due",
			1,
			"blob-referenced-due",
			"metadata",
			0,
			1,
			1_000,
			"user-1",
			"local-1",
			"mutation-1",
		);

		expect(earliestGcDeadline(blobGcStore.readGcDeadlines(2_000), 2_000)).toBeNull();
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

function deleteUnreferencedStagedBlob(
	staleStagedBlobStore: Awaited<ReturnType<typeof createSqliteCoordinator>>["staleStagedBlobStore"],
	blobId: string,
	now: number,
): "deleted" | "missing" | "referenced" {
	return staleStagedBlobStore.withStagedBlobTransaction(
		blobId,
		now,
		(transaction) => {
			const facts = transaction.readFacts();
			if (!facts.blob) {
				return "missing";
			}
			if (
				facts.blob.state !== "staged" ||
				isBlobPinned(facts.referenceFacts, false)
			) {
				return "referenced";
			}
			transaction.deleteStagedBlob();
			return "deleted";
		},
	);
}

function markBlobPendingDeleteIfUnpinned(
	blobGcStore: Awaited<ReturnType<typeof createSqliteCoordinator>>["blobGcStore"],
	blobId: string,
	now: number,
): void {
	blobGcStore.withPendingDeleteTransaction(blobId, now, (transaction) => {
		const facts = transaction.readFacts();
		if (!facts) {
			return;
		}
		const decision = decidePendingDelete(facts, now);
		if (decision.kind === "mark_pending_delete") {
			transaction.markPendingDelete(decision.deleteAfter);
		}
	});
}
