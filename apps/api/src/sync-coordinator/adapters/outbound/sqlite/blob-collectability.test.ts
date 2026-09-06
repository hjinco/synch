import { afterEach, describe, expect, it } from "vitest";
import {
	createSqliteCoordinator,
	closeAllTestSqliteCoordinators,
} from "./test-helpers";
import { decideBlobCollection } from "../../../domain/blob-gc-policy";
import { deleteCollectibleBlobRecords } from "../../../application/services/blob-record-operations";
import type { BlobState } from "../../../application/ports/outbound/storage-models";

afterEach(closeAllTestSqliteCoordinators);

describe("SQL and domain GC contract", () => {
	it("agrees at reference, retention, state and grace-period boundaries for reads and deletes", async () => {
		const { unitOfWork } = await createSqliteCoordinator();
		const now = 1000;
		const expected: string[] = [];
		let count = 0;
		unitOfWork.run((stores) => {
			for (const state of [
				"staged",
				"live",
				"pending_delete",
			] satisfies BlobState[]) {
				for (const deleteAfter of [null, now - 1, now, now + 1]) {
					for (const current of [false, true]) {
						for (const historyExpiry of [null, now - 1, now, now + 1]) {
							const id = `blob-${count++}`;
							stores.blobs.persistStage(id, {
								sizeBytes: 1,
								now: 1,
								deleteAfter: 1,
							});
							stores.blobs.updateState(id, state, deleteAfter);
							if (current)
								stores.entries.upsertEntry({
									entryId: id,
									revision: 1,
									blobId: id,
									encryptedMetadata: "ciphertext",
									deleted: false,
									updatedSeq: 1,
									updatedAt: 1,
									updatedByUserId: "user",
									updatedByLocalVaultId: "local",
									lastMutationId: id,
								});
							if (historyExpiry !== null)
								stores.versions.insertEntryVersion({
									versionId: id,
									entryId: id,
									sourceRevision: 1,
									opType: "upsert",
									blobId: id,
									encryptedMetadata: "ciphertext",
									reason: "auto",
									bucketStartMs: 0,
									createdAt: 1,
									expiresAt: historyExpiry,
									createdByUserId: "user",
									createdByLocalVaultId: "local",
								});
							const facts = {
								state,
								deleteAfter,
								hasCurrentReference: current,
								hasRetainedHistory:
									historyExpiry !== null && historyExpiry > now,
							};
							expect(stores.blobReferences.read(id, now)).toMatchObject({
								hasCurrentReference: facts.hasCurrentReference,
								hasRetainedHistory: facts.hasRetainedHistory,
							});
							const collectible =
								decideBlobCollection(facts, now).kind === "collectible";
							expect(stores.gc.readCollectibleBlob(id, now) !== null).toBe(
								collectible,
							);
							if (collectible) expected.push(id);
						}
					}
				}
			}
			stores.state.adjustStorageUsedBytes(count);
		});
		const listed = unitOfWork.stores.gc.listCollectibleBlobs(now, count);
		expect(listed.map((row) => row.blob_id).sort()).toEqual(expected.sort());
		for (const row of listed)
			expect(
				decideBlobCollection(
					{
						state: row.state,
						deleteAfter: row.delete_after,
						...row.referenceFacts,
					},
					now,
				).kind,
			).toBe("collectible");
		const deleted = unitOfWork.run((stores) =>
			deleteCollectibleBlobRecords(
				stores,
				Array.from({ length: count }, (_, i) => `blob-${i}`),
				now,
			),
		);
		expect(deleted.map((row) => row.blob_id).sort()).toEqual(expected);
		expect(unitOfWork.stores.state.readStorageUsedBytes()).toBe(
			count - expected.length,
		);
	});

	it("applies reference filtering before LIMIT so pinned rows cannot starve collectible rows", async () => {
		const { unitOfWork } = await createSqliteCoordinator();
		unitOfWork.run((stores) => {
			for (let i = 0; i < 12; i++) {
				const id = `blob-${String(i).padStart(2, "0")}`;
				stores.blobs.persistStage(id, { sizeBytes: 1, now: 1, deleteAfter: 2 });
				if (i < 10)
					stores.entries.upsertEntry({
						entryId: id,
						revision: 1,
						blobId: id,
						encryptedMetadata: "ciphertext",
						deleted: false,
						updatedSeq: 1,
						updatedAt: 1,
						updatedByUserId: "user",
						updatedByLocalVaultId: "local",
						lastMutationId: id,
					});
			}
		});
		expect(
			unitOfWork.stores.gc.listCollectibleBlobs(2, 1).map((row) => row.blob_id),
		).toEqual(["blob-10"]);
	});
});
