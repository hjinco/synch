import { afterEach, describe, expect, it } from "vitest";

import { decideDeletedEntryPurge } from "../../../domain/entry-policy";
import {
	closeAllTestSqliteCoordinators,
	createSqliteCoordinator,
	testSession,
} from "./test-helpers";

afterEach(() => {
	closeAllTestSqliteCoordinators();
});

async function commit(
	store: Awaited<ReturnType<typeof createSqliteCoordinator>>["mutationService"],
	entryId: string,
	mutationId: string,
	baseRevision: number,
) {
	return store.commitMutations(testSession(), {
		type: "commit_mutations",
		requestId: `req-${mutationId}`,
		mutations: [
			{
				mutationId,
				entryId,
				op: "upsert",
				baseRevision,
				blobId: null,
				encryptedMetadata: `ciphertext-${mutationId}`,
			},
		],
	});
}

describe("sqlite backend: entry state listing", () => {
	it("filters recovery pages and counts, including tombstones, within the snapshot", async () => {
		const { entryStore } = await createSqliteCoordinator();
		for (let index = 1; index <= 4; index++) {
			entryStore.upsertEntry({
				entryId: `entry-${index}`, revision: 2, blobId: null,
				encryptedMetadata: "encrypted", deleted: index === 3,
				updatedSeq: index, updatedAt: 1, updatedByUserId: "user",
				updatedByLocalVaultId: "local", lastMutationId: `mutation-${index}`,
			});
		}
		const ids = ["entry-1", "entry-3", "entry-4", "missing", "entry-1"];
		expect(entryStore.countEntryStates(0, 3, ids)).toBe(2);
		const first = entryStore.listEntryStates(0, 3, null, 1, ids);
		expect(first.map((entry) => entry.entry_id)).toEqual(["entry-1"]);
		expect(entryStore.listEntryStates(0, 3, { updatedSeq: 1, entryId: "entry-1" }, 1, ids))
			.toMatchObject([{ entry_id: "entry-3", deleted: true }]);
		expect(entryStore.listEntryStates(1, 3, null, 10, ids).map((entry) => entry.entry_id))
			.toEqual(["entry-3"]);
		expect(entryStore.countEntryStates(0, 3, [])).toBe(0);
	});

	it("lists stored encrypted blob sizes without dropping entries with no blob", async () => {
		const { entryStore, blobStore } = await createSqliteCoordinator();
		blobStore.persistStage("blob-sized", { sizeBytes: 4097, now: 1, deleteAfter: 100 });
		for (const [index, blobId] of ["blob-sized", null, "missing-blob"].entries()) {
			entryStore.upsertEntry({
				entryId: `entry-${index}`, revision: 1, blobId,
				encryptedMetadata: "encrypted", deleted: index === 1,
				updatedSeq: index + 1, updatedAt: 1,
				updatedByUserId: "user", updatedByLocalVaultId: "local", lastMutationId: `mutation-${index}`,
			});
		}
		expect(entryStore.listEntryStates(0, 3, null, 10).map((entry) => entry.blob_size))
			.toEqual([4097, null, null]);
	});

	it("pages entries by (updated_seq, entry_id) after the given cursor", async () => {
		const { mutationService, entryStore } = await createSqliteCoordinator();

		await commit(mutationService, "entry-1", "m1", 0);
		await commit(mutationService, "entry-2", "m2", 0);
		await commit(mutationService, "entry-3", "m3", 0);

		const firstPage = entryStore.listEntryStates(0, 3, null, 2);
		expect(firstPage.map((row) => row.entry_id)).toEqual([
			"entry-1",
			"entry-2",
		]);

		const secondPage = entryStore.listEntryStates(
			0,
			3,
			{ updatedSeq: firstPage[1].updated_seq, entryId: firstPage[1].entry_id },
			2,
		);
		expect(secondPage.map((row) => row.entry_id)).toEqual(["entry-3"]);

		expect(entryStore.countEntryStates(0, 3)).toBe(3);
	});
});

describe("sqlite backend: entry history", () => {
	it("uses stored expiry for listing, restoring and deleted-entry recovery before GC", async () => {
		const { historyStore, entryStore } = await createSqliteCoordinator();
		entryStore.upsertEntry({
			entryId: "deleted", revision: 2, blobId: null, encryptedMetadata: "encrypted",
			deleted: true, updatedSeq: 2, updatedAt: 100, updatedByUserId: "user",
			updatedByLocalVaultId: "local", lastMutationId: "delete",
		});
		for (const [versionId, expiresAt] of [["short", 200], ["long", 500]] as const) {
			historyStore.insertEntryVersion({
				versionId, entryId: "deleted", sourceRevision: 1, opType: "upsert",
				blobId: "blob", encryptedMetadata: "encrypted", reason: "auto", bucketStartMs: null,
				createdAt: 100, expiresAt, createdByUserId: "user", createdByLocalVaultId: "local",
			});
		}
		expect(historyStore.listEntryVersions("deleted", null, 200, 10).map(row => row.version_id)).toEqual(["long"]);
		expect(historyStore.readEntryVersion("deleted", "short", 200)).toBeNull();
		expect(historyStore.readEntryVersion("deleted", "long", 499)).not.toBeNull();
		expect(historyStore.hasRestorableHistory("deleted", 499)).toBe(true);
		expect(entryStore.listDeletedEntries(null, 499, 10)).toHaveLength(1);
		expect(historyStore.listEntryVersions("deleted", null, 500, 10)).toEqual([]);
		expect(historyStore.readEntryVersion("deleted", "long", 500)).toBeNull();
		expect(historyStore.hasRestorableHistory("deleted", 500)).toBe(false);
		expect(entryStore.listDeletedEntries(null, 500, 10)).toEqual([]);
		historyStore.expireEntryVersions(200);
		expect(historyStore.listEntryVersions("deleted", null, 0, 10).map(row => row.version_id)).toEqual(["long"]);
		historyStore.expireEntryVersions(500);
		expect(historyStore.listEntryVersions("deleted", null, 0, 10)).toEqual([]);
	});

	it("captures an auto version on a second mutation and lists it", async () => {
		const { mutationService, historyStore } = await createSqliteCoordinator();

		await commit(mutationService, "entry-1", "m1", 0);
		await commit(mutationService, "entry-1", "m2", 1);

		const versions = historyStore.listEntryVersions("entry-1", null, 0, 10);
		expect(versions.length).toBeGreaterThanOrEqual(1);
		expect(versions[0]).toMatchObject({ entry_id: "entry-1", reason: "auto" });
	});

	it("rejects purging a deleted entry with no restorable history", async () => {
		const { unitOfWork, mutationService } = await createSqliteCoordinator();
		await commit(mutationService, "entry-1", "m1", 0);
		await mutationService.commitMutations(testSession(), {
			type: "commit_mutations",
			requestId: "req-delete",
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
		});

		const decision = unitOfWork.run((stores) =>
			decideDeletedEntryPurge({
				current: stores.entries.readMutationEntry("entry-1"),
				receivedRevision: 2,
				hasRestorableHistory: stores.versions.hasRestorableHistory(
					"entry-1",
					0,
				),
			}),
		);
		expect(decision).toEqual({ kind: "no_history" });
	});
});
