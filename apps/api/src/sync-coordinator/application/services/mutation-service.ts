import { decideEntryMutation } from "../../domain/entry-policy";
import type {
	BlobObjectKeyBuilder,
	BlobObjectRepository,
	MutationStore,
	VaultStateStore,
} from "../ports/outbound";
import type {
	CommitMutationBatchResult,
	CommitMutationMessage,
	CommitMutationResult,
	CommitMutationsMessage,
	CommitMutationsResult,
	SocketSession,
} from "../dto/types";
import type { BlobGcService } from "./blob-gc-service";
import type { HealthService } from "./health-service";

export class MutationService {
	constructor(
		private readonly mutationStore: MutationStore,
		private readonly blobGcService: Pick<BlobGcService, "scheduleNext">,
		private readonly vaultStateStore: Pick<
			VaultStateStore,
			"readVersionHistoryRetentionDays"
		>,
		private readonly blobRepository: BlobObjectRepository,
		private readonly objectKeyBuilder: BlobObjectKeyBuilder,
		private readonly blobGracePeriodMs: number,
		private readonly healthService: Pick<HealthService, "scheduleSummaryFlush">,
	) {}

	async commitMutations(
		session: SocketSession,
		message: CommitMutationsMessage,
		options: { forcedHistoryBefore?: "before_restore" | null } = {},
	): Promise<CommitMutationsResult> {
		const upsertBlobIds = new Set(
			message.mutations
				.filter((mutation) => mutation.op === "upsert" && mutation.blobId)
				.map((mutation) => mutation.blobId as string),
		);
		const unavailableBlobIds = new Set<string>();
		await Promise.all(
			Array.from(upsertBlobIds, async (blobId) => {
				const blobExists = await this.blobRepository.exists(
					this.objectKeyBuilder.blobObjectKey(session.vaultId, blobId),
				);
				if (!blobExists) {
					unavailableBlobIds.add(blobId);
				}
			}),
		);

		const now = Date.now();
		const versionHistoryRetentionMs =
			this.vaultStateStore.readVersionHistoryRetentionDays() * DAY_IN_MS;
		const result = this.mutationStore.withTransaction((transaction) => {
			const results: CommitMutationBatchResult[] = [];
			let highestResponseCursor: number | null = null;
			let highestBroadcastCursor: number | null = null;
			const seenMutationIds = new Set<string>();

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

				const current = transaction.readEntry(mutation.entryId);
				const mutationDecision = decideEntryMutation({
					current: current
						? {
								revision: current.revision,
								lastMutationId: current.lastMutationId,
							}
						: null,
					mutationId,
					baseRevision: Number(mutation.baseRevision),
					op: mutation.op,
					blobId: mutation.blobId,
					forcedHistoryBefore: options.forcedHistoryBefore ?? null,
					now,
				});

				if (mutationDecision.kind === "idempotent") {
					if (!current) {
						throw new Error("idempotent mutation has no current entry");
					}
					highestResponseCursor = Math.max(
						highestResponseCursor ?? 0,
						current.updatedSeq,
					);
					results.push({
						status: "accepted",
						mutationId,
						cursor: current.updatedSeq,
						entryId: current.entryId,
						revision: current.revision,
					});
					continue;
				}

				if (mutationDecision.kind === "stale_revision") {
					results.push({
						status: "rejected",
						mutationId,
						entryId: mutation.entryId,
						code: "stale_revision",
						message: `expected base revision ${mutationDecision.expectedBaseRevision} but received ${mutationDecision.receivedBaseRevision}`,
						expectedBaseRevision: mutationDecision.expectedBaseRevision,
						receivedBaseRevision: mutationDecision.receivedBaseRevision,
					});
					continue;
				}

				const nextBlobId = mutationDecision.nextBlobId;
				const currentBlobId = current?.blobId ?? null;
				if (nextBlobId) {
					if (unavailableBlobIds.has(nextBlobId)) {
						results.push({
							status: "rejected",
							mutationId,
							entryId: mutation.entryId,
							code: "blob_not_found",
							message: `blob ${nextBlobId} is not available`,
						});
						continue;
					}

					const nextBlobState = transaction.readBlobState(nextBlobId);
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
						transaction.restagePendingDeleteBlob(
							nextBlobId,
							now + this.blobGracePeriodMs,
						);
					}
				}

				const versionExpiresAt = now + versionHistoryRetentionMs;
				if (mutationDecision.forcedHistoryBefore && current) {
					transaction.insertEntryVersion({
						versionId: crypto.randomUUID(),
						entryId: mutation.entryId,
						sourceRevision: current.revision,
						opType: current.deleted ? "delete" : "upsert",
						blobId: current.blobId,
						encryptedMetadata: current.encryptedMetadata,
						reason: mutationDecision.forcedHistoryBefore,
						bucketStartMs: null,
						createdAt: now,
						expiresAt: versionExpiresAt,
						createdByUserId: session.userId,
						createdByLocalVaultId: session.localVaultId,
					});
				}

				const cursor = transaction.allocateCursor(session.vaultId);
				transaction.upsertEntry({
					entryId: mutation.entryId,
					revision: mutationDecision.revision,
					blobId: nextBlobId,
					encryptedMetadata: mutation.encryptedMetadata,
					deleted: mutationDecision.nextDeleted,
					updatedSeq: cursor,
					updatedAt: now,
					updatedByUserId: session.userId,
					updatedByLocalVaultId: session.localVaultId,
					lastMutationId: mutationId,
				});

				if (mutationDecision.captureAutoVersion) {
					transaction.insertEntryVersion({
						versionId: crypto.randomUUID(),
						entryId: mutation.entryId,
						sourceRevision: mutationDecision.revision,
						opType: mutation.op,
						blobId: nextBlobId,
						encryptedMetadata: mutation.encryptedMetadata,
						reason: "auto",
						bucketStartMs: mutationDecision.autoVersionBucketStart,
						createdAt: now,
						expiresAt: versionExpiresAt,
						createdByUserId: session.userId,
						createdByLocalVaultId: session.localVaultId,
						ignoreConflict: true,
					});
				}

				if (nextBlobId) {
					transaction.markBlobLive(nextBlobId);
				}
				if (currentBlobId && currentBlobId !== nextBlobId) {
					transaction.markBlobPendingDeleteIfUnreferenced(
						currentBlobId,
						now,
					);
				}

				highestResponseCursor = Math.max(highestResponseCursor ?? 0, cursor);
				highestBroadcastCursor = Math.max(
					highestBroadcastCursor ?? 0,
					cursor,
				);
				results.push({
					status: "accepted",
					mutationId,
					cursor,
					entryId: mutation.entryId,
					revision: mutationDecision.revision,
				});
			}

			transaction.finalizeCommit(now);
			const responseCursor =
				highestResponseCursor ??
				transaction.readCurrentCursor(session.vaultId);
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

		if (result.broadcastCursor !== null) {
			await this.blobGcService.scheduleNext();
			await this.healthService.scheduleSummaryFlush();
		}
		return result;
	}

	async commitMutation(
		session: SocketSession,
		message: CommitMutationMessage,
		options: { forcedHistoryBefore?: "before_restore" | null } = {},
	): Promise<CommitMutationResult> {
		const batch = await this.commitMutations(
			session,
			{
				type: "commit_mutations",
				requestId: message.requestId,
				mutations: [message.mutation],
			},
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
}

const DAY_IN_MS = 24 * 60 * 60 * 1000;
