import type { MaintenanceScheduler } from "../../ports/outbound";
import type {
	BlobStateStore,
	BlobObjectRepository,
	HealthSummaryScheduler,
		MutationStore,
		VaultStateStore,
		BlobObjectKeyBuilder,
} from "../../ports/outbound";
import type {
	CommitMutationMessage,
	CommitMutationResult,
	CommitMutationsMessage,
	CommitMutationsResult,
	SocketSession,
} from "../../dto/types";

export class MutationCommitService {
	constructor(
		private readonly mutationStore: MutationStore,
		private readonly blobStore: Pick<BlobStateStore, "nextBlobGcAt">,
		private readonly vaultStateStore: Pick<
			VaultStateStore,
			"readVersionHistoryRetentionDays"
		>,
		private readonly blobRepository: BlobObjectRepository,
		private readonly objectKeyBuilder: BlobObjectKeyBuilder,
		private readonly blobGracePeriodMs: number,
		private readonly maintenanceScheduler: MaintenanceScheduler,
		private readonly healthSummaryScheduler: HealthSummaryScheduler,
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

		const result = await this.mutationStore.commitMutations(
			session,
			message,
			this.blobGracePeriodMs,
			this.vaultStateStore.readVersionHistoryRetentionDays() * DAY_IN_MS,
			{
				...options,
				unavailableBlobIds,
			},
		);
		if (result.broadcastCursor !== null) {
			const nextGcAt = this.blobStore.nextBlobGcAt();
			if (nextGcAt !== null) {
				await this.maintenanceScheduler.defer("blob_gc", nextGcAt);
			}
			await this.healthSummaryScheduler.scheduleSummaryFlush();
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
