import { and, eq } from "drizzle-orm";

import * as doSchema from "../../../../db/do";
import type {
	MutationEntrySnapshot,
	MutationStore,
	MutationTransaction,
} from "../../../application/ports/outbound/mutation-store";
import { CoordinatorBlobStore } from "./blob-store";
import type { CoordinatorStorageHandle } from "./storage-handle";

type InsertEntryVersionInput = Parameters<
	MutationTransaction["insertEntryVersion"]
>[0];
type UpsertEntryInput = Parameters<MutationTransaction["upsertEntry"]>[0];

export class CoordinatorMutationStore implements MutationStore {
	private readonly blobStore: CoordinatorBlobStore;

	constructor(private readonly handle: CoordinatorStorageHandle) {
		this.blobStore = new CoordinatorBlobStore(handle);
	}

	withTransaction<T>(
		operation: (transaction: MutationTransaction) => T,
	): T {
		return this.handle.db.transaction((tx) => {
			let initialCursor: number | null = null;
			let nextCursor: number | null = null;

			const readEntry = (entryId: string): MutationEntrySnapshot | null => {
				const row = tx
					.select({
						entryId: doSchema.entries.entryId,
						revision: doSchema.entries.revision,
						blobId: doSchema.entries.blobId,
						encryptedMetadata: doSchema.entries.encryptedMetadata,
						deleted: doSchema.entries.deleted,
						updatedSeq: doSchema.entries.updatedSeq,
						lastMutationId: doSchema.entries.lastMutationId,
					})
					.from(doSchema.entries)
					.where(eq(doSchema.entries.entryId, entryId))
					.limit(1)
					.get();

				return row
					? {
							entryId: row.entryId,
							revision: Number(row.revision),
							blobId: row.blobId,
							encryptedMetadata: row.encryptedMetadata,
							deleted: Number(row.deleted) !== 0,
							updatedSeq: Number(row.updatedSeq),
							lastMutationId: row.lastMutationId,
						}
					: null;
			};

			const readCurrentCursor = (vaultId: string): number => {
				const state = tx
					.select({
						vaultId: doSchema.coordinatorState.vaultId,
						currentCursor: doSchema.coordinatorState.currentCursor,
					})
					.from(doSchema.coordinatorState)
					.where(eq(doSchema.coordinatorState.id, 1))
					.limit(1)
					.get();
				if (!state) {
					throw new Error("vault sync state is not initialized");
				}
				if (state.vaultId !== vaultId) {
					throw new Error("durable object vault id mismatch");
				}
				return Number(state.currentCursor);
			};

			const allocateCursor = (vaultId: string): number => {
				if (nextCursor === null) {
					initialCursor = readCurrentCursor(vaultId);
					nextCursor = initialCursor;
				}

				nextCursor += 1;
				return nextCursor;
			};

			const insertEntryVersion = (input: InsertEntryVersionInput): boolean => {
				const existingAutoVersion =
					input.ignoreConflict && input.bucketStartMs !== null
						? tx
								.select({
									versionId: doSchema.entryVersions.versionId,
								})
								.from(doSchema.entryVersions)
								.where(
									and(
										eq(doSchema.entryVersions.entryId, input.entryId),
										eq(doSchema.entryVersions.reason, input.reason),
										eq(
											doSchema.entryVersions.bucketStartMs,
											input.bucketStartMs,
										),
									),
								)
								.limit(1)
								.get()
						: null;
				if (existingAutoVersion) {
					return false;
				}

				tx.insert(doSchema.entryVersions)
					.values({
						versionId: input.versionId,
						entryId: input.entryId,
						sourceRevision: input.sourceRevision,
						opType: input.opType,
						blobId: input.blobId,
						encryptedMetadata: input.encryptedMetadata,
						reason: input.reason,
						bucketStartMs: input.bucketStartMs,
						capturedAt: input.createdAt,
						expiresAt: input.expiresAt,
						createdByUserId: input.createdByUserId,
						createdByLocalVaultId: input.createdByLocalVaultId,
					})
					.onConflictDoNothing()
					.run();

				return true;
			};

			const upsertEntry = (input: UpsertEntryInput): void => {
				tx.insert(doSchema.entries)
					.values({
						entryId: input.entryId,
						revision: input.revision,
						blobId: input.blobId,
						encryptedMetadata: input.encryptedMetadata,
						deleted: input.deleted ? 1 : 0,
						updatedSeq: input.updatedSeq,
						updatedAt: input.updatedAt,
						updatedByUserId: input.updatedByUserId,
						updatedByLocalVaultId: input.updatedByLocalVaultId,
						lastMutationId: input.lastMutationId,
					})
					.onConflictDoUpdate({
						target: doSchema.entries.entryId,
						set: {
							revision: input.revision,
							blobId: input.blobId,
							encryptedMetadata: input.encryptedMetadata,
							deleted: input.deleted ? 1 : 0,
							updatedSeq: input.updatedSeq,
							updatedAt: input.updatedAt,
							updatedByUserId: input.updatedByUserId,
							updatedByLocalVaultId: input.updatedByLocalVaultId,
							lastMutationId: input.lastMutationId,
						},
					})
					.run();
			};

			const transaction: MutationTransaction = {
				readEntry,
				readBlobState: (blobId) => this.blobStore.readBlobState(tx, blobId),
				restagePendingDeleteBlob: (blobId, deleteAfter) =>
					this.blobStore.restagePendingDeleteBlob(tx, blobId, deleteAfter),
				insertEntryVersion,
				readCurrentCursor,
				allocateCursor,
				upsertEntry,
				markBlobLive: (blobId) => this.blobStore.markBlobLive(tx, blobId),
				markBlobPendingDeleteIfUnreferenced: (blobId, deleteAfter) =>
					this.blobStore.markBlobPendingDeleteIfUnreferenced(
						tx,
						blobId,
						deleteAfter,
					),
				finalizeCommit: (now) => {
					if (
						nextCursor !== null &&
						initialCursor !== null &&
						nextCursor > initialCursor
					) {
						tx.update(doSchema.coordinatorState)
							.set({
								currentCursor: nextCursor,
								lastCommitAt: now,
							})
							.where(eq(doSchema.coordinatorState.id, 1))
							.run();
					}
				},
			};

			return operation(transaction);
		});
	}
}
