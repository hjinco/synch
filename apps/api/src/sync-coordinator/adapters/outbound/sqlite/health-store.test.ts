import { afterEach, describe, expect, it } from "vitest";

import { PENDING_DELETE_STALE_MS } from "../../../domain/health-policy";
import { CoordinatorHealthStore } from "./health-store";
import type { CoordinatorStorageHandle } from "./storage-handle";
import {
	closeAllTestSqliteCoordinators,
	createSqliteCoordinator,
	testSession,
} from "./test-helpers";

afterEach(() => {
	closeAllTestSqliteCoordinators();
});

describe("sqlite backend: health summary", () => {
	it("reports entry/blob counts and defers to the injected socket counter", async () => {
		const { handle, mutationStore } = await createSqliteCoordinator();
		const healthStore = new CoordinatorHealthStore(handle, { count: () => 3 });

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
		);

		const snapshot = healthStore.readHealthSnapshot(10_000, 30 * 24 * 60 * 60 * 1000);
		expect(snapshot).toMatchObject({
			vaultId: "vault-1",
			entryCount: 1,
			websocketCount: 3,
		});
	});

	it("counts version-pinned pending_delete as census only", async () => {
		const { handle, healthStore } = await createSqliteCoordinator();
		const now = 1_000_000;
		insertPendingDeleteBlob(handle, "blob-pinned", now - PENDING_DELETE_STALE_MS);
		insertEntryVersion(handle, {
			blobId: "blob-pinned",
			expiresAt: now + 1,
		});

		const snapshot = healthStore.readHealthSnapshot(now, 30 * 24 * 60 * 60 * 1000);

		expect(snapshot).toMatchObject({
			pendingDeleteBlobCount: 1,
			collectiblePendingDeleteBlobCount: 0,
			oldestPendingDeleteAgeMs: null,
		});
	});

	it("treats unpinned past-due pending_delete as collectible", async () => {
		const { handle, healthStore } = await createSqliteCoordinator();
		const now = 1_000_000;
		const deleteAfter = now - 5_000;
		insertPendingDeleteBlob(handle, "blob-collectible", deleteAfter);

		const snapshot = healthStore.readHealthSnapshot(now, 30 * 24 * 60 * 60 * 1000);

		expect(snapshot).toMatchObject({
			pendingDeleteBlobCount: 1,
			collectiblePendingDeleteBlobCount: 1,
			oldestPendingDeleteAgeMs: now - deleteAfter,
		});
	});

	it("reports collectible pending_delete age without evaluating health", async () => {
		const { handle, healthStore } = await createSqliteCoordinator();
		const now = PENDING_DELETE_STALE_MS + 5_000;
		insertPendingDeleteBlob(handle, "blob-stale", 0);

		const snapshot = healthStore.readHealthSnapshot(now, 30 * 24 * 60 * 60 * 1000);

		expect(snapshot).toMatchObject({
			collectiblePendingDeleteBlobCount: 1,
			oldestPendingDeleteAgeMs: now,
		});
	});
});

function insertPendingDeleteBlob(
	handle: CoordinatorStorageHandle,
	blobId: string,
	deleteAfter: number,
): void {
	handle.exec(
		`
		INSERT INTO blobs (
			blob_id, state, size_bytes, created_at, last_uploaded_at, delete_after
		) VALUES (?, 'pending_delete', 100, ?, ?, ?)
		`,
		blobId,
		deleteAfter,
		deleteAfter,
		deleteAfter,
	);
}

function insertEntryVersion(
	handle: CoordinatorStorageHandle,
	input: { blobId: string; expiresAt: number },
): void {
	handle.exec(
		`
		INSERT INTO entry_versions (
			version_id, entry_id, source_revision, op_type, blob_id,
			encrypted_metadata, reason, bucket_start_ms, captured_at, expires_at,
			created_by_user_id, created_by_local_vault_id
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`,
		"version-1",
		"entry-1",
		1,
		"upsert",
		input.blobId,
		"metadata",
		"before_delete",
		null,
		1,
		input.expiresAt,
		"user-1",
		"local-1",
	);
}
