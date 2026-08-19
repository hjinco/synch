import type {
	CommitMutationMessage,
	CommitMutationResult,
	CommitMutationsMessage,
	CommitMutationsResult,
	EntryVersionReason,
	SocketSession,
} from "../../dto/types";

export interface MutationStore {
	commitMutations(
		session: SocketSession,
		message: CommitMutationsMessage,
		stageGracePeriodMs: number,
		versionHistoryRetentionMs: number,
		options?: {
			forcedHistoryBefore?: EntryVersionReason | null;
			unavailableBlobIds?: ReadonlySet<string>;
		},
	): Promise<CommitMutationsResult>;
}

export interface MutationCommitter {
	commitMutation(
		session: SocketSession,
		message: CommitMutationMessage,
		options?: { forcedHistoryBefore?: "before_restore" | null },
	): Promise<CommitMutationResult>;
	commitMutations(
		session: SocketSession,
		message: CommitMutationsMessage,
		options?: { forcedHistoryBefore?: "before_restore" | null },
	): Promise<CommitMutationsResult>;
}
