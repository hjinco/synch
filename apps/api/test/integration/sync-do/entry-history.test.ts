import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
	apiRequest,
	initializeCoordinatorState,
	issueSyncToken,
	signUpAndCreateVault,
	uniqueId,
} from "../../helpers/api";
import {
	commitMutation,
	listDeletedEntries,
	listEntryVersions,
	purgeDeletedEntries,
	restoreEntryVersion,
	uploadBlob,
} from "./helpers";

describe("sync durable object entry history integration", () => {
	it("keeps sampled entry versions, lists history, and restores client-assisted history", async () => {
		const primary = await signUpAndCreateVault();
		const token = await issueSyncToken(primary.sessionCookie, primary.vaultId, "local-vault-history");
		const stub = env.SYNC_COORDINATOR.getByName(primary.vaultId);
		const session = {
			userId: primary.userId,
			localVaultId: "local-vault-history",
			vaultId: primary.vaultId,
		};
		const entryId = "entry-history";
		const blobA = uniqueId("blob");
		const blobB = uniqueId("blob");

		await uploadBlob(primary.vaultId, token.token, blobA, "body-a");
		await commitMutation(stub, session, {
			mutationId: "mutation-history-a",
			entryId,
			op: "upsert",
			baseRevision: 0,
			blobId: blobA,
			encryptedMetadata: "meta-a",
		});

		await uploadBlob(primary.vaultId, token.token, blobB, "body-b");
		await commitMutation(stub, session, {
			mutationId: "mutation-history-b",
			entryId,
			op: "upsert",
			baseRevision: 1,
			blobId: blobB,
			encryptedMetadata: "meta-b",
		});

		const historicalBlob = await runInDurableObject(stub, async (_instance, state) => {
			const row = state.storage.sql
				.exec<{ state: string; delete_after: number | null }>(
					"SELECT state, delete_after FROM blobs WHERE blob_id = ?",
					blobA,
				)
				.toArray()[0];
			const references = state.storage.sql
				.exec<{ source: string }>(
					`
					SELECT 'current_entry' AS source FROM entries WHERE blob_id = ?
					UNION
					SELECT 'entry_version' AS source FROM entry_versions WHERE blob_id = ?
					ORDER BY source
					`,
					blobA,
					blobA,
				)
				.toArray()
				.map((reference) => reference.source);
			return {
				state: row?.state ?? null,
				deleteAfter: row?.delete_after === null ? null : Number(row.delete_after),
				references,
			};
		});
		expect(historicalBlob.state).toBe("pending_delete");
		expect(historicalBlob.references).toEqual([]);
		expect(historicalBlob.deleteAfter).not.toBeNull();
		expect(
			historicalBlob.deleteAfter ?? Number.POSITIVE_INFINITY,
		).toBeLessThanOrEqual(Date.now());

		const history = await listEntryVersions(stub, session, {
			entryId,
			before: null,
			limit: 500,
		});
		expect(history.entryId).toBe(entryId);
		expect(history.versions.map((version) => version.sourceRevision)).toEqual([2]);
		expect(history.versions.map((version) => version.blobId)).toEqual([blobB]);
		expect(history.versions.map((version) => version.encryptedMetadata)).toEqual(["meta-b"]);
		expect(history.versions.map((version) => version.reason)).toEqual(["auto"]);
		expect(history.hasMore).toBe(false);
		expect(history.nextBefore).toBeNull();

		const restored = await restoreEntryVersion(stub, session, {
			entryId,
			versionId: history.versions[0].versionId,
			baseRevision: 2,
			op: history.versions[0].op,
			blobId: history.versions[0].blobId,
			encryptedMetadata: "meta-b-restored",
		});
		expect(restored.message).toEqual(
			expect.objectContaining({
				type: "entry_version_restored",
				entryId,
				restoredFromVersionId: history.versions[0].versionId,
				restoredFromRevision: 2,
				revision: 3,
			}),
		);

		const restoredEntry = await runInDurableObject(stub, async (_instance, state) => {
			return state.storage.sql
				.exec<{ revision: number; blob_id: string | null; encrypted_metadata: string }>(
					"SELECT revision, blob_id, encrypted_metadata FROM entries WHERE entry_id = ?",
					entryId,
				)
				.toArray()[0];
		});
		expect(restoredEntry).toEqual({
			revision: 3,
			blob_id: blobB,
			encrypted_metadata: "meta-b-restored",
		});

		const pagedHistory = await listEntryVersions(stub, session, {
			entryId,
			before: null,
			limit: 1,
		});
		expect(pagedHistory.versions.map((version) => version.reason)).toEqual(["before_restore"]);
		expect(pagedHistory.hasMore).toBe(true);
		expect(pagedHistory.nextBefore).not.toBeNull();

		const blobStates = await runInDurableObject(stub, async (_instance, state) => {
			const rows = state.storage.sql
				.exec<{ blob_id: string; state: string; delete_after: number | null }>(
					"SELECT blob_id, state, delete_after FROM blobs WHERE blob_id IN (?, ?) ORDER BY blob_id",
					blobA,
					blobB,
				)
				.toArray();
			return rows.map((row) => ({
				blobId: row.blob_id,
				state: row.state,
				deleteAfter: row.delete_after === null ? null : Number(row.delete_after),
				references: state.storage.sql
					.exec<{ source: string }>(
						`
						SELECT 'current_entry' AS source FROM entries WHERE blob_id = ?
						UNION
						SELECT 'entry_version' AS source FROM entry_versions WHERE blob_id = ?
						ORDER BY source
						`,
						row.blob_id,
						row.blob_id,
					)
					.toArray()
					.map((reference) => reference.source),
			}));
		});
		const blobAState = blobStates.find((blob) => blob.blobId === blobA);
		if (blobAState) {
			expect(blobAState).toEqual({
				blobId: blobA,
				state: "pending_delete",
				deleteAfter: expect.any(Number),
				references: [],
			});
		}
		expect(blobStates).toEqual(
			expect.arrayContaining([
				{
					blobId: blobB,
					state: "live",
					deleteAfter: null,
					references: expect.arrayContaining(["current_entry", "entry_version"]),
				},
			]),
		);
	});

	it("does not create entry history for an initial create revision", async () => {
		const primary = await signUpAndCreateVault();
		const token = await issueSyncToken(
			primary.sessionCookie,
			primary.vaultId,
			"local-vault-initial-history",
		);
		const stub = env.SYNC_COORDINATOR.getByName(primary.vaultId);
		const session = {
			userId: primary.userId,
			localVaultId: "local-vault-initial-history",
			vaultId: primary.vaultId,
		};
		const entryId = "entry-initial-history";
		const blobId = uniqueId("blob-initial-history");

		await uploadBlob(primary.vaultId, token.token, blobId, "initial body");
		await commitMutation(stub, session, {
			mutationId: "mutation-initial-history",
			entryId,
			op: "upsert",
			baseRevision: 0,
			blobId,
			encryptedMetadata: "meta-initial",
		});

		const historyCount = await runInDurableObject(stub, async (_instance, state) => {
			const row = state.storage.sql
				.exec<{ count: number }>(
					"SELECT count(*) AS count FROM entry_versions WHERE entry_id = ?",
					entryId,
				)
				.toArray()[0];
			return Number(row?.count ?? 0);
		});
		expect(historyCount).toBe(0);

		const history = await listEntryVersions(stub, session, {
			entryId,
			before: null,
			limit: 500,
		});
		expect(history.versions).toEqual([]);
		expect(history.hasMore).toBe(false);
	});

	it("keeps deleted entry blobs until before-delete history expires", async () => {
		const primary = await signUpAndCreateVault();
		const token = await issueSyncToken(
			primary.sessionCookie,
			primary.vaultId,
			"local-vault-delete-history",
		);
		const stub = env.SYNC_COORDINATOR.getByName(primary.vaultId);
		const session = {
			userId: primary.userId,
			localVaultId: "local-vault-delete-history",
			vaultId: primary.vaultId,
		};
		const entryId = "entry-delete-history";
		const blobId = uniqueId("blob-delete-history");

		await uploadBlob(primary.vaultId, token.token, blobId, "deleted body");
		await commitMutation(stub, session, {
			mutationId: "mutation-delete-history-create",
			entryId,
			op: "upsert",
			baseRevision: 0,
			blobId,
			encryptedMetadata: "meta-create",
		});
		await commitMutation(stub, session, {
			mutationId: "mutation-delete-history-delete",
			entryId,
			op: "delete",
			baseRevision: 1,
			blobId: null,
			encryptedMetadata: "meta-delete",
		});

		const beforeExpiry = await runInDurableObject(stub, async (instance, state) => {
			await (instance as unknown as { runGc: () => Promise<void> }).runGc();
			const blob = state.storage.sql
				.exec<{ state: string; delete_after: number | null }>(
					"SELECT state, delete_after FROM blobs WHERE blob_id = ?",
					blobId,
				)
				.toArray()[0];
			const version = state.storage.sql
				.exec<{ reason: string; blob_id: string | null }>(
					"SELECT reason, blob_id FROM entry_versions WHERE entry_id = ?",
					entryId,
				)
				.toArray()[0];
			return {
				blob: {
					state: blob?.state ?? null,
					deleteAfter:
						blob?.delete_after === null ? null : Number(blob?.delete_after),
				},
				version,
			};
		});
		expect(beforeExpiry.blob.state).toBe("pending_delete");
		expect(
			beforeExpiry.blob.deleteAfter ?? Number.POSITIVE_INFINITY,
		).toBeLessThanOrEqual(Date.now());
		expect(beforeExpiry.version).toEqual({
			reason: "before_delete",
			blob_id: blobId,
		});

		const stillDownloadable = await apiRequest(
			`/v1/vaults/${encodeURIComponent(primary.vaultId)}/blobs/${blobId}`,
			{
				headers: {
					authorization: `Bearer ${token.token}`,
				},
			},
		);
		expect(stillDownloadable.status).toBe(200);

		await runInDurableObject(stub, async (instance, state) => {
			state.storage.sql.exec(
				"UPDATE entry_versions SET expires_at = ? WHERE blob_id = ?",
				Date.now() - 1,
				blobId,
			);
			await (instance as unknown as { runGc: () => Promise<void> }).runGc();
		});

		const deleted = await apiRequest(
			`/v1/vaults/${encodeURIComponent(primary.vaultId)}/blobs/${blobId}`,
			{
				headers: {
					authorization: `Bearer ${token.token}`,
				},
			},
		);
		expect(deleted.status).toBe(404);
	});

	it("purges deleted entry history and immediately reclaims unpinned blob storage", async () => {
		const primary = await signUpAndCreateVault();
		const token = await issueSyncToken(
			primary.sessionCookie,
			primary.vaultId,
			"local-vault-purge-history",
		);
		const stub = env.SYNC_COORDINATOR.getByName(primary.vaultId);
		const session = {
			userId: primary.userId,
			localVaultId: "local-vault-purge-history",
			vaultId: primary.vaultId,
		};
		const entryId = "entry-purge-history";
		const blobId = uniqueId("blob-purge-history");

		await uploadBlob(primary.vaultId, token.token, blobId, "purged body");
		await commitMutation(stub, session, {
			mutationId: "mutation-purge-history-create",
			entryId,
			op: "upsert",
			baseRevision: 0,
			blobId,
			encryptedMetadata: "meta-create",
		});
		await commitMutation(stub, session, {
			mutationId: "mutation-purge-history-delete",
			entryId,
			op: "delete",
			baseRevision: 1,
			blobId: null,
			encryptedMetadata: "meta-delete",
		});

		const beforePurge = await runInDurableObject(stub, async (_instance, state) => {
			const storage = state.storage.sql
				.exec<{ storage_used_bytes: number }>(
					"SELECT storage_used_bytes FROM coordinator_state WHERE id = 1",
				)
				.toArray()[0];
			return Number(storage?.storage_used_bytes ?? 0);
		});
		expect(beforePurge).toBeGreaterThan(0);

		const purged = await purgeDeletedEntries(stub, session, [
			{ entryId, revision: 2 },
		]);
		expect(purged.message.results).toEqual([
			{
				status: "accepted",
				entryId,
			},
		]);

		const listed = await listDeletedEntries(stub, session, {
			before: null,
			limit: 25,
		});
		expect(listed.entries.map((entry) => entry.entryId)).not.toContain(entryId);

		const afterPurge = await runInDurableObject(stub, async (_instance, state) => {
			const storage = state.storage.sql
				.exec<{ storage_used_bytes: number }>(
					"SELECT storage_used_bytes FROM coordinator_state WHERE id = 1",
				)
				.toArray()[0];
			const blob = state.storage.sql
				.exec<{ blob_id: string }>(
					"SELECT blob_id FROM blobs WHERE blob_id = ?",
					blobId,
				)
				.toArray()[0];
			const versions = state.storage.sql
				.exec<{ count: number }>(
					"SELECT count(*) AS count FROM entry_versions WHERE entry_id = ?",
					entryId,
				)
				.toArray()[0];
			const entry = state.storage.sql
				.exec<{ deleted: number; revision: number }>(
					"SELECT deleted, revision FROM entries WHERE entry_id = ?",
					entryId,
				)
				.toArray()[0];
			return {
				storageUsedBytes: Number(storage?.storage_used_bytes ?? 0),
				hasBlob: !!blob,
				versionCount: Number(versions?.count ?? 0),
				entry,
			};
		});
		expect(afterPurge).toEqual({
			storageUsedBytes: 0,
			hasBlob: false,
			versionCount: 0,
			entry: {
				deleted: 1,
				revision: 2,
			},
		});

		const deletedBlob = await apiRequest(
			`/v1/vaults/${encodeURIComponent(primary.vaultId)}/blobs/${blobId}`,
			{
				headers: {
					authorization: `Bearer ${token.token}`,
				},
			},
		);
		expect(deletedBlob.status).toBe(404);
	});

	it("does not delete purged history blobs that are still pinned by another version", async () => {
		const primary = await signUpAndCreateVault();
		const token = await issueSyncToken(
			primary.sessionCookie,
			primary.vaultId,
			"local-vault-purge-shared-history",
		);
		const stub = env.SYNC_COORDINATOR.getByName(primary.vaultId);
		const session = {
			userId: primary.userId,
			localVaultId: "local-vault-purge-shared-history",
			vaultId: primary.vaultId,
		};
		const blobId = uniqueId("blob-purge-shared-history");

		await uploadBlob(primary.vaultId, token.token, blobId, "shared body");
		for (const entryId of ["entry-shared-a", "entry-shared-b"]) {
			await commitMutation(stub, session, {
				mutationId: `mutation-${entryId}-create`,
				entryId,
				op: "upsert",
				baseRevision: 0,
				blobId,
				encryptedMetadata: `meta-create-${entryId}`,
			});
			await commitMutation(stub, session, {
				mutationId: `mutation-${entryId}-delete`,
				entryId,
				op: "delete",
				baseRevision: 1,
				blobId: null,
				encryptedMetadata: `meta-delete-${entryId}`,
			});
		}

		const purged = await purgeDeletedEntries(stub, session, [
			{ entryId: "entry-shared-a", revision: 2 },
		]);
		expect(purged.message.results).toEqual([
			{
				status: "accepted",
				entryId: "entry-shared-a",
			},
		]);

		const stillDownloadable = await apiRequest(
			`/v1/vaults/${encodeURIComponent(primary.vaultId)}/blobs/${blobId}`,
			{
				headers: {
					authorization: `Bearer ${token.token}`,
				},
			},
		);
		expect(stillDownloadable.status).toBe(200);

		const state = await runInDurableObject(stub, async (_instance, storageState) => {
			const versions = storageState.storage.sql
				.exec<{ entry_id: string }>(
					"SELECT entry_id FROM entry_versions WHERE blob_id = ? ORDER BY entry_id",
					blobId,
				)
				.toArray()
				.map((row) => row.entry_id);
			const storage = storageState.storage.sql
				.exec<{ storage_used_bytes: number }>(
					"SELECT storage_used_bytes FROM coordinator_state WHERE id = 1",
				)
				.toArray()[0];
			const blob = storageState.storage.sql
				.exec<{ state: string }>(
					"SELECT state FROM blobs WHERE blob_id = ?",
					blobId,
				)
				.toArray()[0];
			return {
				versions,
				storageUsedBytes: Number(storage?.storage_used_bytes ?? 0),
				blobState: blob?.state ?? null,
			};
		});
		expect(state.versions).toEqual(["entry-shared-b"]);
		expect(state.storageUsedBytes).toBeGreaterThan(0);
		expect(state.blobState).toBe("pending_delete");
	});

	it("returns per-entry failures when purging invalid deleted entries", async () => {
		const primary = await signUpAndCreateVault();
		const token = await issueSyncToken(
			primary.sessionCookie,
			primary.vaultId,
			"local-vault-purge-failures",
		);
		const stub = env.SYNC_COORDINATOR.getByName(primary.vaultId);
		const session = {
			userId: primary.userId,
			localVaultId: "local-vault-purge-failures",
			vaultId: primary.vaultId,
		};

		const activeBlobId = uniqueId("blob-purge-active");
		await uploadBlob(primary.vaultId, token.token, activeBlobId, "active body");
		await commitMutation(stub, session, {
			mutationId: "mutation-purge-active-create",
			entryId: "entry-active",
			op: "upsert",
			baseRevision: 0,
			blobId: activeBlobId,
			encryptedMetadata: "meta-active",
		});

		await initializeCoordinatorState(primary.vaultId);
		await runInDurableObject(stub, async (_instance, state) => {
			state.storage.sql.exec(
				`
				INSERT INTO entries (
					entry_id,
					revision,
					blob_id,
					encrypted_metadata,
					deleted,
					updated_seq,
					updated_at,
					updated_by_user_id,
					updated_by_local_vault_id
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				`,
				"entry-no-history",
				2,
				null,
				"meta-no-history",
				1,
				2,
				Date.now(),
				primary.userId,
				"local-vault-purge-failures",
			);
		});

		const purged = await purgeDeletedEntries(stub, session, [
			{ entryId: "entry-missing", revision: 1 },
			{ entryId: "entry-active", revision: 1 },
			{ entryId: "entry-no-history", revision: 1 },
			{ entryId: "entry-no-history", revision: 2 },
		]);

		expect(purged.message.results).toEqual([
			expect.objectContaining({
				status: "rejected",
				entryId: "entry-missing",
				code: "not_found",
			}),
			expect.objectContaining({
				status: "rejected",
				entryId: "entry-active",
				code: "not_deleted",
			}),
			expect.objectContaining({
				status: "rejected",
				entryId: "entry-no-history",
				code: "stale_revision",
				expectedRevision: 2,
			}),
			expect.objectContaining({
				status: "rejected",
				entryId: "entry-no-history",
				code: "no_history",
			}),
		]);
	});

	it("lists restorable deleted entries in retention-window pages", async () => {
		const primary = await signUpAndCreateVault();
		const token = await issueSyncToken(
			primary.sessionCookie,
			primary.vaultId,
			"local-vault-deleted-list",
		);
		const stub = env.SYNC_COORDINATOR.getByName(primary.vaultId);
		const session = {
			userId: primary.userId,
			localVaultId: token.localVaultId,
			vaultId: primary.vaultId,
		};
		const now = Date.now();
		const oldTimestamp = now - 25 * 60 * 60 * 1000;

		await initializeCoordinatorState(primary.vaultId);
		await runInDurableObject(stub, async (_instance, state) => {
			const insertDeletedEntry = (
				entryId: string,
				deletedAt: number,
				encryptedMetadata: string,
			) => {
				state.storage.sql.exec(
					`
					INSERT INTO entries (
						entry_id,
						revision,
						blob_id,
						encrypted_metadata,
						deleted,
						updated_seq,
						updated_at,
						updated_by_user_id,
						updated_by_local_vault_id
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
					`,
					entryId,
					2,
					null,
					encryptedMetadata,
					1,
					deletedAt,
					deletedAt,
					primary.userId,
					"local-vault-deleted-list",
				);
			};
			const insertVersion = (
				entryId: string,
				versionId: string,
				blobId: string | null,
				capturedAt: number,
			) => {
				state.storage.sql.exec(
					`
					INSERT INTO entry_versions (
						version_id,
						entry_id,
						source_revision,
						op_type,
						blob_id,
						encrypted_metadata,
						reason,
						bucket_start_ms,
						captured_at,
						expires_at,
						created_by_user_id,
						created_by_local_vault_id
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					`,
					versionId,
					entryId,
					1,
					blobId ? "upsert" : "delete",
					blobId,
					`history-${entryId}`,
					"before_delete",
					null,
					capturedAt,
					capturedAt + 24 * 60 * 60 * 1000,
					primary.userId,
					"local-vault-deleted-list",
				);
			};

			insertDeletedEntry("entry-a", now + 300, "delete-a");
			insertVersion("entry-a", "version-a", "blob-a", now);
			insertDeletedEntry("entry-c", now + 200, "delete-c");
			insertVersion("entry-c", "version-c", "blob-c", now);
			insertDeletedEntry("entry-b", now + 200, "delete-b");
			insertVersion("entry-b", "version-b", "blob-b", now);
			insertDeletedEntry("entry-no-upsert", now + 100, "delete-no-upsert");
			insertVersion("entry-no-upsert", "version-no-upsert", null, now);
			insertDeletedEntry("entry-expired", now + 50, "delete-expired");
			insertVersion("entry-expired", "version-expired", "blob-expired", oldTimestamp);

			for (let index = 0; index < 101; index += 1) {
				const entryId = `entry-cap-${String(index).padStart(3, "0")}`;
				insertDeletedEntry(entryId, now - 1_000 - index, `delete-cap-${index}`);
				insertVersion(entryId, `version-cap-${index}`, `blob-cap-${index}`, now);
			}
		});

		const firstPage = await listDeletedEntries(stub, session, {
			before: null,
			limit: 2,
		});
		expect(firstPage.entries.map((entry) => entry.entryId)).toEqual([
			"entry-a",
			"entry-c",
		]);
		expect(firstPage.hasMore).toBe(true);
		expect(firstPage.nextBefore).toEqual({
			deletedAt: now + 200,
			entryId: "entry-c",
		});

		const secondPage = await listDeletedEntries(stub, session, {
			before: firstPage.nextBefore,
			limit: 2,
		});
		expect(secondPage.entries.map((entry) => entry.entryId)).toEqual([
			"entry-b",
			"entry-cap-000",
		]);
		expect(
			secondPage.entries.some((entry) =>
				["entry-no-upsert", "entry-expired"].includes(entry.entryId),
			),
		).toBe(false);

		const capped = await listDeletedEntries(stub, session, {
			before: null,
			limit: 500,
		});
		expect(capped.entries).toHaveLength(100);
		expect(capped.hasMore).toBe(true);
	});

	it("retains sampled entry versions after older blobs are collected", async () => {
		const primary = await signUpAndCreateVault();
		const token = await issueSyncToken(primary.sessionCookie, primary.vaultId, "local-vault-checkpoints");
		const stub = env.SYNC_COORDINATOR.getByName(primary.vaultId);
		const session = {
			userId: primary.userId,
			localVaultId: "local-vault-checkpoints",
			vaultId: primary.vaultId,
		};
		const entryId = "entry-checkpoint";
		const blobIds: string[] = [];

		for (let revision = 1; revision <= 31; revision += 1) {
			const blobId = uniqueId(`blob-checkpoint-${revision}`);
			blobIds.push(blobId);
			await uploadBlob(primary.vaultId, token.token, blobId, `body-${revision}`);
			await commitMutation(stub, session, {
				mutationId: `mutation-checkpoint-${revision}`,
				entryId,
				op: "upsert",
				baseRevision: revision - 1,
				blobId,
				encryptedMetadata: `meta-${revision}`,
			});
		}

		const collected = await runInDurableObject(stub, async (instance, state) => {
			await (instance as unknown as { runGc: () => Promise<void> }).runGc();
			const version = state.storage.sql
				.exec<{ source_revision: number; blob_id: string | null; encrypted_metadata: string }>(
					"SELECT source_revision, blob_id, encrypted_metadata FROM entry_versions WHERE entry_id = ?",
					entryId,
				)
				.toArray()[0];
			const blob1 = state.storage.sql
				.exec<{ blob_id: string }>("SELECT blob_id FROM blobs WHERE blob_id = ?", blobIds[0])
				.toArray()[0];
			const blob30 = state.storage.sql
				.exec<{ blob_id: string }>("SELECT blob_id FROM blobs WHERE blob_id = ?", blobIds[29])
				.toArray()[0];
			const blob31 = state.storage.sql
				.exec<{ blob_id: string }>("SELECT blob_id FROM blobs WHERE blob_id = ?", blobIds[30])
				.toArray()[0];
			return {
				version,
				hasBlob1: !!blob1,
				hasBlob30: !!blob30,
				hasBlob31: !!blob31,
			};
		});

		expect(collected.version).toEqual({
			source_revision: 2,
			blob_id: blobIds[1],
			encrypted_metadata: "meta-2",
		});
		expect(collected.hasBlob1).toBe(false);
		expect(collected.hasBlob30).toBe(false);
		expect(collected.hasBlob31).toBe(true);

		const history = await listEntryVersions(stub, session, {
			entryId,
			before: null,
			limit: 10,
		});
		const restored = await restoreEntryVersion(stub, session, {
			entryId,
			versionId: history.versions[0].versionId,
			baseRevision: 31,
			op: history.versions[0].op,
			blobId: history.versions[0].blobId,
			encryptedMetadata: "meta-2-restored",
		});
		expect(restored.message).toEqual(
			expect.objectContaining({
				type: "entry_version_restored",
				entryId,
				restoredFromVersionId: history.versions[0].versionId,
				restoredFromRevision: 2,
				revision: 32,
			}),
		);
	});

	it("limits entry history and restore to the last 1 day", async () => {
		const primary = await signUpAndCreateVault();
		const token = await issueSyncToken(primary.sessionCookie, primary.vaultId, "local-vault-history-window");
		const stub = env.SYNC_COORDINATOR.getByName(primary.vaultId);
		const session = {
			userId: primary.userId,
			localVaultId: token.localVaultId,
			vaultId: primary.vaultId,
		};
		const now = Date.now();
		const oldTimestamp = now - 25 * 60 * 60 * 1000;

		await initializeCoordinatorState(primary.vaultId);
		await runInDurableObject(stub, async (_instance, state) => {
			state.storage.sql.exec(
				`
				INSERT INTO entries (
					entry_id,
					revision,
					blob_id,
					encrypted_metadata,
					deleted,
					updated_seq,
					updated_at,
					updated_by_user_id,
					updated_by_local_vault_id
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				`,
				"entry-window",
				2,
				null,
				"meta-new",
				0,
				2,
				now,
				primary.userId,
				"local-vault-window",
			);
			state.storage.sql.exec(
				`
				INSERT INTO entry_versions (
					version_id,
					entry_id,
					source_revision,
					op_type,
					blob_id,
					encrypted_metadata,
					reason,
					bucket_start_ms,
					captured_at,
					expires_at,
					created_by_user_id,
					created_by_local_vault_id
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`,
				"window-old",
				"entry-window",
				1,
				"upsert",
				null,
				"meta-old",
				"auto",
				oldTimestamp - (oldTimestamp % (5 * 60 * 1000)),
				oldTimestamp,
				oldTimestamp + 24 * 60 * 60 * 1000,
				primary.userId,
				"local-vault-window-old",
			);
			state.storage.sql.exec(
				`
				INSERT INTO entry_versions (
					version_id,
					entry_id,
					source_revision,
					op_type,
					blob_id,
					encrypted_metadata,
					reason,
					bucket_start_ms,
					captured_at,
					expires_at,
					created_by_user_id,
					created_by_local_vault_id
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`,
				"window-new",
				"entry-window",
				2,
				"upsert",
				null,
				"meta-new",
				"auto",
				now - (now % (5 * 60 * 1000)),
				now,
				now + 24 * 60 * 60 * 1000,
				primary.userId,
				"local-vault-window-new",
			);
		});

		const history = await listEntryVersions(stub, session, {
			entryId: "entry-window",
			before: null,
			limit: 500,
		});
		expect(history.versions).toEqual([
			expect.objectContaining({
				sourceRevision: 2,
				blobId: null,
				encryptedMetadata: "meta-new",
				op: "upsert",
			}),
		]);

		await expect(
			restoreEntryVersion(stub, session, {
				entryId: "entry-window",
				versionId: "window-old",
				baseRevision: 2,
				op: "upsert",
				blobId: null,
				encryptedMetadata: "meta-old-restored",
			}),
		).rejects.toMatchObject({
			status: 404,
		});

		await runInDurableObject(stub, async (instance, state) => {
			await (instance as unknown as { runGc: () => Promise<void> }).runGc();
			const rows = state.storage.sql
				.exec<{ version_id: string }>(
					"SELECT version_id FROM entry_versions ORDER BY version_id ASC",
				)
				.toArray();
			expect(rows).toEqual([{ version_id: "window-new" }]);
		});
	});
});
