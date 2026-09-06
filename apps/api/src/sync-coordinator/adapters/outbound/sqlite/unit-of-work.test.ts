import { afterEach, describe, expect, it } from "vitest";
import type {
	InsertEntryVersionInput,
	UpsertEntryInput,
} from "../../../application/ports/outbound";
import {
	deleteCollectibleBlobRecords,
	deleteUnreferencedStagedBlob,
} from "../../../application/services/blob-record-operations";
import { stageBlobForTest } from "../../../test-helpers";
import {
	closeAllTestSqliteCoordinators,
	createSqliteCoordinator,
	testSession,
} from "./test-helpers";

afterEach(closeAllTestSqliteCoordinators);
const entry: UpsertEntryInput = {
	entryId: "entry",
	revision: 1,
	blobId: "blob",
	encryptedMetadata: "ciphertext",
	deleted: false,
	updatedSeq: 1,
	updatedAt: 100,
	updatedByUserId: "user",
	updatedByLocalVaultId: "local",
	lastMutationId: "m1",
};
const version: InsertEntryVersionInput = {
	versionId: "version",
	entryId: "entry",
	sourceRevision: 1,
	opType: "upsert",
	blobId: "blob",
	encryptedMetadata: "ciphertext",
	reason: "auto",
	bucketStartMs: 0,
	createdAt: 100,
	expiresAt: 1000,
	createdByUserId: "user",
	createdByLocalVaultId: "local",
};

describe("coordinator unit of work", () => {
	it("shares writes with reads across stores and rolls every table back on failure", async () => {
		const { unitOfWork } = await createSqliteCoordinator();
		const failure = new Error("injected failure");
		expect(() =>
			unitOfWork.run((stores) => {
				stores.blobs.persistStage("blob", {
					sizeBytes: 10,
					now: 100,
					deleteAfter: 200,
				});
				stores.state.adjustStorageUsedBytes(10);
				stores.entries.upsertEntry(entry);
				stores.versions.insertEntryVersion(version);
				stores.state.saveCommit(1, 100);
				stores.connections.recordLocalVaultConnection("user", "local", 100);
				expect(stores.entries.listEntryStates(0, 1, null, 10)).toHaveLength(1);
				expect(
					stores.versions.listEntryVersions("entry", null, 0, 10),
				).toHaveLength(1);
				expect(stores.blobReferences.read("blob", 100)).toEqual({
					hasCurrentReference: true,
					hasRetainedHistory: true,
				});
				throw failure;
			}),
		).toThrow(failure);
		expect(unitOfWork.stores.blobs.readBlob("blob")).toBeNull();
		expect(unitOfWork.stores.entries.readEntry("entry")).toBeNull();
		expect(
			unitOfWork.stores.versions.listEntryVersions("entry", null, 0, 10),
		).toEqual([]);
		expect(unitOfWork.stores.state.currentCursor()).toBe(0);
		expect(unitOfWork.stores.state.readStorageUsedBytes()).toBe(0);
	});

	it("counts repeated staging once and preserves the original staging age", async () => {
		const { unitOfWork } = await createSqliteCoordinator();
		stageBlobForTest(unitOfWork, "blob", 10, 100, 200);
		stageBlobForTest(unitOfWork, "blob", 10, 150, 250);
		expect(unitOfWork.stores.state.readStorageUsedBytes()).toBe(10);
		expect(unitOfWork.stores.blobs.readBlob("blob")).toMatchObject({
			created_at: 100,
			last_uploaded_at: 150,
			delete_after: 250,
		});
	});

	it("rolls back a mutation batch when persistence fails after an accepted sibling", async () => {
		const { unitOfWork, handle, mutationService } =
			await createSqliteCoordinator();
		stageBlobForTest(unitOfWork, "blob", 10, Date.now(), Date.now() + 1000);
		handle.exec(`CREATE TRIGGER fail_second_entry BEFORE INSERT ON entries
   WHEN NEW.entry_id = 'entry-2' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
		await expect(
			mutationService.commitMutations(testSession(), {
				type: "commit_mutations",
				requestId: "batch",
				mutations: ["entry-1", "entry-2"].map((entryId) => ({
					entryId,
					mutationId: entryId,
					op: "upsert" as const,
					baseRevision: 0,
					blobId: "blob",
					encryptedMetadata: "ciphertext",
				})),
			}),
		).rejects.toThrow();
		expect(unitOfWork.stores.state.currentCursor()).toBe(0);
		expect(unitOfWork.stores.entries.readEntry("entry-1")).toBeNull();
		expect(
			unitOfWork.stores.versions.listEntryVersions("entry-1", null, 0, 10),
		).toEqual([]);
		expect(unitOfWork.stores.blobs.readBlob("blob")?.state).toBe("staged");
	});

	it("restores deleted records if accounting fails, and accounts once on retry", async () => {
		const { unitOfWork, handle } = await createSqliteCoordinator();
		stageBlobForTest(unitOfWork, "blob", 10, 100, 200);
		handle.exec(`CREATE TRIGGER fail_accounting BEFORE UPDATE OF storage_used_bytes ON coordinator_state
   BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
		expect(() =>
			unitOfWork.run((stores) =>
				deleteCollectibleBlobRecords(stores, ["blob"], 200),
			),
		).toThrow();
		expect(unitOfWork.stores.blobs.readBlob("blob")).not.toBeNull();
		expect(unitOfWork.stores.state.readStorageUsedBytes()).toBe(10);
		handle.exec("DROP TRIGGER fail_accounting");
		expect(
			unitOfWork.run((stores) =>
				deleteUnreferencedStagedBlob(stores, "blob", 200),
			),
		).toBe("deleted");
		expect(
			unitOfWork.run((stores) =>
				deleteUnreferencedStagedBlob(stores, "blob", 200),
			),
		).toBe("missing");
		expect(unitOfWork.stores.state.readStorageUsedBytes()).toBe(0);
	});

	it("reports version conflicts without overwriting the first snapshot in a bucket", async () => {
		const { unitOfWork } = await createSqliteCoordinator();
		unitOfWork.run((stores) => {
			expect(stores.versions.insertEntryVersion(version)).toBe(true);
			expect(
				stores.versions.insertEntryVersion({
					...version,
					versionId: "second",
					encryptedMetadata: "later",
				}),
			).toBe(false);
			expect(
				stores.versions.insertEntryVersion({ ...version, bucketStartMs: 1000 }),
			).toBe(false);
		});
		expect(
			unitOfWork.stores.versions.listEntryVersions("entry", null, 0, 10),
		).toMatchObject([
			{ version_id: "version", encrypted_metadata: "ciphertext" },
		]);
	});

	it("rejects promise-returning callbacks before committing writes", async () => {
		const { unitOfWork } = await createSqliteCoordinator();
		expect(() =>
			unitOfWork.run(() => {
				unitOfWork.stores.state.adjustStorageUsedBytes(10);
				// Exercise untyped callers without scheduling an async continuation.
				return { then() {} } as unknown as void;
			}),
		).toThrow(TypeError);
		expect(unitOfWork.stores.state.readStorageUsedBytes()).toBe(0);
	});
});
