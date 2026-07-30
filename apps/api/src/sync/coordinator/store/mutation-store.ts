import { and, eq } from "drizzle-orm";

import * as doSchema from "../../../db/do";
import type {
	CommitMutationBatchResult,
	CommitMutationMessage,
	CommitMutationResult,
	CommitMutationsMessage,
	CommitMutationsResult,
	EntryVersionReason,
	SocketSession,
} from "../types";
import { CoordinatorBlobStore } from "./blob-store";
import { CoordinatorCursorStore } from "./cursor-store";
import type { CoordinatorStorageHandle } from "./storage-handle";

const AUTO_ENTRY_VERSION_BUCKET_MS = 5 * 60 * 1000;

export class CoordinatorMutationStore {
	private readonly blobStore: CoordinatorBlobStore;
	private readonly cursorStore: CoordinatorCursorStore;

	constructor(private readonly handle: CoordinatorStorageHandle) {
		this.blobStore = new CoordinatorBlobStore(handle);
		this.cursorStore = new CoordinatorCursorStore(handle);
	}

	async commitMutation(
		session: SocketSession,
		message: CommitMutationMessage,
		stageGracePeriodMs: number,
		versionHistoryRetentionMs: number,
		options: { forcedHistoryBefore?: EntryVersionReason | null } = {},
	): Promise<CommitMutationResult> {
		const batch = await this.commitMutations(
			session,
			{
				type: "commit_mutations",
				requestId: message.requestId,
				mutations: [message.mutation],
			},
			stageGracePeriodMs,
			versionHistoryRetentionMs,
			options,
		);
		const result = batch.message.results[0];
		if (!result) {
			throw new Error("commit batch returned no result");
		}

		if (result.status === "accepted") {
			return {
				message: {
					type: "commit_accepted",
					requestId: message.requestId,
					cursor: result.cursor,
					entryId: result.entryId,
					revision: result.revision,
				},
				broadcastCursor: batch.broadcastCursor,
			};
		}

		return {
			message: {
				type: "commit_rejected",
				requestId: message.requestId,
				code: result.code,
				message: result.message,
				expectedBaseRevision: result.expectedBaseRevision,
				receivedBaseRevision: result.receivedBaseRevision,
			},
			broadcastCursor: null,
		};
	}

	async commitMutations(
		session: SocketSession,
		message: CommitMutationsMessage,
		stageGracePeriodMs: number,
		versionHistoryRetentionMs: number,
		options: {
			forcedHistoryBefore?: EntryVersionReason | null;
			unavailableBlobIds?: ReadonlySet<string>;
		} = {},
	): Promise<CommitMutationsResult> {
		const now = Date.now();

		return this.handle.db.transaction((tx) => {
			const results: CommitMutationBatchResult[] = [];
			let highestResponseCursor: number | null = null;
			let highestBroadcastCursor: number | null = null;
			let initialCursor: number | null = null;
			let nextCursor: number | null = null;
			const seenMutationIds = new Set<string>();
			const allocateCursor = (): number => {
				if (nextCursor === null) {
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
					if (state.vaultId !== session.vaultId) {
						throw new Error("durable object vault id mismatch");
					}
					initialCursor = Number(state.currentCursor);
					nextCursor = initialCursor;
				}

				nextCursor += 1;
				return nextCursor;
			};
			const insertEntryVersion = (input: {
				versionId: string;
				entryId: string;
				sourceRevision: number;
				opType: "upsert" | "delete";
				blobId: string | null;
				encryptedMetadata: string;
				reason: EntryVersionReason;
				bucketStartMs: number | null;
				createdByUserId: string;
				createdByLocalVaultId: string;
				expiresAt: number;
				ignoreConflict?: boolean;
			}): boolean => {
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
						capturedAt: now,
						expiresAt: input.expiresAt,
						createdByUserId: input.createdByUserId,
						createdByLocalVaultId: input.createdByLocalVaultId,
					})
					.onConflictDoNothing()
					.run();

				return true;
			};

			for (const mutation of message.mutations) {
				const mutationId = mutation.mutationId.trim();
				if (seenMutationIds.has(mutationId)) {
					results.push({
						status: "rejected",
						mutationId,
						entryId: mutation.entryId,
						code: "duplicate_mutation_id",
						message: `duplicate mutation id ${mutationId} in batch`,
					});
					continue;
				}
				seenMutationIds.add(mutationId);

				const current = tx
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
					.where(eq(doSchema.entries.entryId, mutation.entryId))
					.limit(1)
					.get();

				if (current?.lastMutationId === mutationId) {
					const cursor = Number(current.updatedSeq);
					highestResponseCursor = Math.max(highestResponseCursor ?? 0, cursor);
					results.push({
						status: "accepted",
						mutationId,
						cursor,
						entryId: current.entryId,
						revision: Number(current.revision),
					});
					continue;
				}

				const currentRevision = Number(current?.revision ?? 0);
				const expectedBaseRevision = Number(mutation.baseRevision);
				if (currentRevision !== expectedBaseRevision) {
					results.push({
						status: "rejected",
						mutationId,
						entryId: mutation.entryId,
						code: "stale_revision",
						message: `expected base revision ${currentRevision} but received ${expectedBaseRevision}`,
						expectedBaseRevision: currentRevision,
						receivedBaseRevision: expectedBaseRevision,
					});
					continue;
				}

				const nextBlobId = mutation.op === "delete" ? null : mutation.blobId;
				const nextDeleted = mutation.op === "delete" ? 1 : 0;
				const currentBlobId = current?.blobId ?? null;

				if (nextBlobId) {
					if (options.unavailableBlobIds?.has(nextBlobId)) {
						results.push({
							status: "rejected",
							mutationId,
							entryId: mutation.entryId,
							code: "blob_not_found",
							message: `blob ${nextBlobId} is not available`,
						});
						continue;
					}

					const nextBlobState = this.blobStore.readBlobState(tx, nextBlobId);
					if (!nextBlobState) {
						results.push({
							status: "rejected",
							mutationId,
							entryId: mutation.entryId,
							code: "blob_not_staged",
							message: `blob ${nextBlobId} was not staged`,
						});
						continue;
					}

					if (nextBlobState === "pending_delete") {
						this.blobStore.restagePendingDeleteBlob(
							tx,
							nextBlobId,
							now + stageGracePeriodMs,
						);
					}
				}

				const revision = currentRevision + 1;
				const versionExpiresAt = now + versionHistoryRetentionMs;
				const forcedHistoryBefore =
					mutation.op === "delete"
						? "before_delete"
						: options.forcedHistoryBefore ?? null;
				if (forcedHistoryBefore && current) {
					insertEntryVersion({
						versionId: crypto.randomUUID(),
						entryId: mutation.entryId,
						sourceRevision: currentRevision,
						opType: Number(current.deleted) === 1 ? "delete" : "upsert",
						blobId: current.blobId,
						encryptedMetadata: current.encryptedMetadata,
						reason: forcedHistoryBefore,
						bucketStartMs: null,
						createdByUserId: session.userId,
						createdByLocalVaultId: session.localVaultId,
						expiresAt: versionExpiresAt,
					});
				}

				const cursor = allocateCursor();

				tx.insert(doSchema.entries)
					.values({
						entryId: mutation.entryId,
						revision,
						blobId: nextBlobId,
						encryptedMetadata: mutation.encryptedMetadata,
						deleted: nextDeleted,
						updatedSeq: cursor,
						updatedAt: now,
						updatedByUserId: session.userId,
						updatedByLocalVaultId: session.localVaultId,
						lastMutationId: mutationId,
					})
					.onConflictDoUpdate({
						target: doSchema.entries.entryId,
						set: {
							revision,
							blobId: nextBlobId,
							encryptedMetadata: mutation.encryptedMetadata,
							deleted: nextDeleted,
							updatedSeq: cursor,
							updatedAt: now,
							updatedByUserId: session.userId,
							updatedByLocalVaultId: session.localVaultId,
							lastMutationId: mutationId,
						},
					})
					.run();

				const shouldCaptureAutoVersion =
					!forcedHistoryBefore && expectedBaseRevision > 0;
				if (shouldCaptureAutoVersion) {
					insertEntryVersion({
						versionId: crypto.randomUUID(),
						entryId: mutation.entryId,
						sourceRevision: revision,
						opType: mutation.op,
						blobId: nextBlobId,
						encryptedMetadata: mutation.encryptedMetadata,
						reason: "auto",
						bucketStartMs:
							Math.floor(now / AUTO_ENTRY_VERSION_BUCKET_MS) *
							AUTO_ENTRY_VERSION_BUCKET_MS,
						createdByUserId: session.userId,
						createdByLocalVaultId: session.localVaultId,
						expiresAt: versionExpiresAt,
						ignoreConflict: true,
					});
				}

				if (nextBlobId) {
					this.blobStore.markBlobLive(tx, nextBlobId);
				}

				if (currentBlobId && currentBlobId !== nextBlobId) {
					this.blobStore.markBlobPendingDeleteIfUnreferenced(
						tx,
						currentBlobId,
						now,
					);
				}

				highestResponseCursor = Math.max(highestResponseCursor ?? 0, cursor);
				highestBroadcastCursor = Math.max(highestBroadcastCursor ?? 0, cursor);
				results.push({
					status: "accepted",
					mutationId,
					cursor,
					entryId: mutation.entryId,
					revision,
				});
			}

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

			const responseCursor =
				highestResponseCursor ?? this.cursorStore.currentCursorInTransaction(tx);
			return {
				message: {
					type: "commit_mutations_committed",
					requestId: message.requestId,
					cursor: responseCursor,
					results,
				},
				broadcastCursor: highestBroadcastCursor,
			} satisfies CommitMutationsResult;
		});
	}

}
