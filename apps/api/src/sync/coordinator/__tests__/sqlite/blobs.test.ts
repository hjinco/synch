import { afterEach, describe, expect, it } from "vitest";

import { DomainError } from "../../../../errors";
import { closeAllTestSqliteCoordinators, createSqliteCoordinator, testSession } from "./helpers";

afterEach(() => {
	closeAllTestSqliteCoordinators();
});

describe("sqlite backend: blob staging", () => {
	it("stages a blob and increments storage used bytes", async () => {
		const { blobStore, healthStore } = await createSqliteCoordinator();

		await blobStore.stageBlob("blob-1", 1_000, 100, 200);

		expect(blobStore.readBlob("blob-1")).toMatchObject({
			blob_id: "blob-1",
			state: "staged",
			size_bytes: 1_000,
		});
		expect(healthStore.readStorageStatus().storageUsedBytes).toBe(1_000);
	});

	it("rejects a blob larger than the configured max file size", async () => {
		const { blobStore } = await createSqliteCoordinator("vault-1", {
			storageLimitBytes: 1_000_000_000,
			maxFileSizeBytes: 10,
			versionHistoryRetentionDays: 1,
		});

		await expect(blobStore.stageBlob("blob-1", 11, 100, 200)).rejects.toThrow(DomainError);
	});

	it("rejects a blob that would exceed the vault storage quota", async () => {
		const { blobStore } = await createSqliteCoordinator("vault-1", {
			storageLimitBytes: 1_000,
			maxFileSizeBytes: 10_000_000,
			versionHistoryRetentionDays: 1,
		});

		await expect(blobStore.stageBlob("blob-1", 2_000, 100, 200)).rejects.toThrow(DomainError);
	});

	it("does not mutate storage_used_bytes when a stage is rejected mid-transaction", async () => {
		const { blobStore, healthStore } = await createSqliteCoordinator("vault-1", {
			storageLimitBytes: 1_000,
			maxFileSizeBytes: 10_000_000,
			versionHistoryRetentionDays: 1,
		});

		await blobStore.stageBlob("blob-a", 500, 100, 200);
		expect(healthStore.readStorageStatus().storageUsedBytes).toBe(500);

		await expect(blobStore.stageBlob("blob-b", 900, 100, 200)).rejects.toThrow(DomainError);

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
		await blobStore.stageBlob("blob-1", 100, 1_000, 2_000);
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
		await expect(blobStore.stageBlob("blob-1", 100, 3_000, 4_000)).rejects.toThrow(
			DomainError,
		);
	});

	it("collects a staged-but-never-committed blob once its grace period passes", async () => {
		const { blobStore } = await createSqliteCoordinator();
		await blobStore.stageBlob("blob-1", 100, 1_000, 1_500);

		const ready = blobStore.listBlobsReadyForDeletion(2_000, 10);
		expect(ready.map((row) => row.blob_id)).toContain("blob-1");

		blobStore.deleteBlobIfCollectible("blob-1", 2_000);
		expect(blobStore.readBlob("blob-1")).toBeNull();
	});

	it("marks a live blob pending-delete once its entry stops referencing it", async () => {
		const { blobStore, mutationStore } = await createSqliteCoordinator();
		await blobStore.stageBlob("blob-1", 100, 1_000, 2_000);
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
