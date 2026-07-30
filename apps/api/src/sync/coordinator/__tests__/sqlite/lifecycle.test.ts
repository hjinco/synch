import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteCoordinatorStorageHandle } from "../../store/sqlite-storage-handle";
import { SqliteCoordinatorStorage } from "../../store/sqlite-storage-lifecycle";
import { closeAllTestSqliteCoordinators, createSqliteCoordinator, testSession } from "./helpers";

afterEach(() => {
	closeAllTestSqliteCoordinators();
});

describe("sqlite backend: storage lifecycle", () => {
	it("migrate() creates the coordinator schema", async () => {
		const sqlite = new Database(":memory:");
		const lifecycle = new SqliteCoordinatorStorage(sqlite);
		await lifecycle.migrate();

		const tables = sqlite
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
			.all() as Array<{ name: string }>;
		const names = tables.map((row) => row.name);
		expect(names).toEqual(
			expect.arrayContaining(["entries", "entry_versions", "blobs", "coordinator_state"]),
		);
	});

	it("purgeVaultState() clears rows but leaves the schema intact for reuse", async () => {
		const { sqlite, mutationStore, cursorStore, entryStore } =
			await createSqliteCoordinator();
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
						blobId: null,
						encryptedMetadata: "ciphertext",
					},
				],
			},
			30 * 60 * 1000,
			24 * 60 * 60 * 1000,
		);
		expect(entryStore.readEntry("entry-1")).not.toBeNull();

		const lifecycle = new SqliteCoordinatorStorage(sqlite);
		const handle = new SqliteCoordinatorStorageHandle(sqlite);
		await lifecycle.purgeVaultState();

		expect(entryStore.readEntry("entry-1")).toBeNull();
		expect(handle.exec("SELECT * FROM coordinator_state").toArray()).toEqual([]);

		// schema must still exist so the vault can be re-provisioned
		cursorStore.ensureVaultState("vault-1", {
			storageLimitBytes: 1,
			maxFileSizeBytes: 1,
			versionHistoryRetentionDays: 1,
		});
		expect(cursorStore.readVaultId()).toBe("vault-1");
	});
});
