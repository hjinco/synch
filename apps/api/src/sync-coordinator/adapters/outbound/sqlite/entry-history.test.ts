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
