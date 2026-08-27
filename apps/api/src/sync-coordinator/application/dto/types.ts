import type { EntryVersionCaptureReason } from "../../domain/entry-policy";
import type { PresenceSelection } from "./protocol-types";

export type {
	ClientControlMessage,
	CommitMutationMessage,
	CommitMutationPayload,
	CommitMutationsMessage,
	DetachLocalVaultMessage,
	HeartbeatMessage,
	HelloMessage,
	ListDeletedEntriesMessage,
	ListEntryStatesMessage,
	ListEntryVersionsMessage,
	PurgeDeletedEntriesMessage,
	PresencePosition,
	PresenceSelection,
	RestoreEntryVersionMessage,
	RestoreEntryVersionsMessage,
	UnwatchPresenceMessage,
	UnwatchStorageStatusMessage,
	PresenceUpdateMessage,
	PresenceClearMessage,
	WatchPresenceMessage,
	WatchStorageStatusMessage,
} from "./protocol-types";

export type HelloAckMessage = {
	type: "hello_ack";
	requestId: string;
	cursor: number;
	policy: VaultPolicySnapshot;
	storageStatus: StorageStatusSnapshot;
	presenceSupported: true;
};

export type VaultPolicySnapshot = {
	storageLimitBytes: number;
	maxFileSizeBytes: number;
};

export type CursorAdvancedMessage = {
	type: "cursor_advanced";
	cursor: number;
};

export type StorageStatusSnapshot = {
	storageUsedBytes: number;
	storageLimitBytes: number;
};

export type StorageStatusUpdatedMessage = {
	type: "storage_status_updated";
	storageStatus: StorageStatusSnapshot;
};

export type PolicyUpdatedMessage = {
	type: "policy_updated";
	policy: VaultPolicySnapshot;
	storageStatus: StorageStatusSnapshot;
};

export type PresenceUpdatedMessage = {
	type: "presence_updated";
	presenceId: string;
	entryId: string;
	userId: string;
	displayName: string;
	selection: PresenceSelection;
};

export type PresenceClearedMessage = {
	type: "presence_cleared";
	presenceId: string;
};

export type PresenceAvailabilityMessage = {
	type: "presence_availability";
	enabled: boolean;
};

export type CommitAcceptedMessage = {
	type: "commit_accepted";
	requestId: string;
	cursor: number;
	entryId: string;
	revision: number;
};

export type LocalVaultDetachedMessage = {
	type: "local_vault_detached";
	requestId: string;
};

export type HeartbeatAckMessage = {
	type: "heartbeat_ack";
	requestId: string;
};

export type CommitRejectedMessage = {
	type: "commit_rejected";
	requestId: string;
	code: string;
	message: string;
	expectedBaseRevision?: number;
	receivedBaseRevision?: number;
};

export type CommitMutationAcceptedBatchResult = {
	status: "accepted";
	mutationId: string;
	cursor: number;
	entryId: string;
	revision: number;
};

export type CommitMutationRejectedBatchResult = {
	status: "rejected";
	mutationId: string;
	entryId: string;
	code:
		| "blob_not_found"
		| "blob_not_staged"
		| "stale_revision"
		| "commit_failed"
		| "duplicate_mutation_id";
	message: string;
	expectedBaseRevision?: number;
	receivedBaseRevision?: number;
};

export type CommitMutationBatchResult =
	| CommitMutationAcceptedBatchResult
	| CommitMutationRejectedBatchResult;

export type CommitMutationsCommittedMessage = {
	type: "commit_mutations_committed";
	requestId: string;
	cursor: number;
	results: CommitMutationBatchResult[];
};

export type CommitMutationsFailedMessage = {
	type: "commit_mutations_failed";
	requestId: string;
	code: string;
	message: string;
};

export type EntryStatePageCursor = {
	updatedSeq: number;
	entryId: string;
};

export type EntryStatesListedMessage = {
	type: "entry_states_listed";
	requestId: string;
	targetCursor: number;
	totalEntries: number;
	hasMore: boolean;
	nextAfter: EntryStatePageCursor | null;
	entries: Array<{
		entryId: string;
		revision: number;
		blobId: string | null;
		encryptedMetadata: string;
		deleted: boolean;
		updatedSeq: number;
		updatedAt: number;
	}>;
};

export type EntryStatesListFailedMessage = {
	type: "entry_states_list_failed";
	requestId: string;
	code: string;
	message: string;
};

export type EntryVersionPageCursor = {
	capturedAt: number;
	versionId: string;
};

export type DeletedEntryPageCursor = {
	deletedAt: number;
	entryId: string;
};

export type EntryVersionsListedMessage = {
	type: "entry_versions_listed";
	requestId: string;
	entryId: string;
	versions: Array<{
		versionId: string;
		sourceRevision: number;
		op: "upsert" | "delete";
		blobId: string | null;
		encryptedMetadata: string;
		reason: EntryVersionCaptureReason;
		capturedAt: number;
	}>;
	hasMore: boolean;
	nextBefore: EntryVersionPageCursor | null;
};

export type EntryVersionsListFailedMessage = {
	type: "entry_versions_list_failed";
	requestId: string;
	code: string;
	message: string;
};

export type DeletedEntriesListedMessage = {
	type: "deleted_entries_listed";
	requestId: string;
	entries: Array<{
		entryId: string;
		revision: number;
		encryptedMetadata: string;
		deletedAt: number;
	}>;
	hasMore: boolean;
	nextBefore: DeletedEntryPageCursor | null;
};

export type DeletedEntriesListFailedMessage = {
	type: "deleted_entries_list_failed";
	requestId: string;
	code: string;
	message: string;
};

export type EntryVersionRestoredMessage = {
	type: "entry_version_restored";
	requestId: string;
	entryId: string;
	restoredFromVersionId: string;
	restoredFromRevision: number;
	cursor: number;
	revision: number;
};

export type RestoreEntryVersionBatchResult =
	| {
			status: "accepted";
			entryId: string;
			restoredFromVersionId: string;
			restoredFromRevision: number;
			cursor: number;
			revision: number;
	  }
	| {
			status: "rejected";
			entryId: string;
			versionId: string;
			code: string;
			message: string;
			expectedBaseRevision?: number;
			receivedBaseRevision?: number;
	  };

export type EntryVersionsRestoredMessage = {
	type: "entry_versions_restored";
	requestId: string;
	cursor: number;
	results: RestoreEntryVersionBatchResult[];
};

export type PurgeDeletedEntryBatchResult =
	| {
			status: "accepted";
			entryId: string;
	  }
	| {
			status: "rejected";
			entryId: string;
			code: "not_found" | "not_deleted" | "stale_revision" | "no_history";
			message: string;
			expectedRevision?: number;
	  };

export type DeletedEntriesPurgedMessage = {
	type: "deleted_entries_purged";
	requestId: string;
	results: PurgeDeletedEntryBatchResult[];
};

export type DeletedEntriesPurgeFailedMessage = {
	type: "deleted_entries_purge_failed";
	requestId: string;
	code: string;
	message: string;
};

export type EntryRestoreFailedMessage = {
	type: "entry_restore_failed";
	requestId: string;
	code: string;
	message: string;
};

export type SessionErrorMessage = {
	type: "session_error";
	code: string;
	message: string;
};

export type ServerControlMessage =
	| HelloAckMessage
	| CursorAdvancedMessage
	| StorageStatusUpdatedMessage
	| PolicyUpdatedMessage
	| CommitAcceptedMessage
	| LocalVaultDetachedMessage
	| HeartbeatAckMessage
	| CommitRejectedMessage
	| CommitMutationsCommittedMessage
	| CommitMutationsFailedMessage
	| EntryStatesListedMessage
	| EntryStatesListFailedMessage
	| EntryVersionsListedMessage
	| EntryVersionsListFailedMessage
	| DeletedEntriesListedMessage
	| DeletedEntriesListFailedMessage
	| EntryVersionRestoredMessage
	| EntryVersionsRestoredMessage
	| DeletedEntriesPurgedMessage
	| DeletedEntriesPurgeFailedMessage
	| EntryRestoreFailedMessage
	| SessionErrorMessage
	| PresenceUpdatedMessage
	| PresenceClearedMessage
	| PresenceAvailabilityMessage;

export type SocketSession = {
	userId: string;
	localVaultId: string;
	vaultId: string;
	displayName: string;
	wantsStorageStatus: boolean;
	wantsPresence: boolean;
	presenceEntryId: string | null;
	presenceWatchEntryIds: string[];
};

export type VaultStateLimits = {
	storageLimitBytes: number;
	maxFileSizeBytes: number;
	versionHistoryRetentionDays: number;
};

export type CommitMutationResult = {
	message: ServerControlMessage;
	broadcastCursor: number | null;
};

export type CommitMutationsResult = {
	message: CommitMutationsCommittedMessage;
	broadcastCursor: number | null;
};

export type RestoreEntryVersionResult = {
	message: EntryVersionRestoredMessage;
	broadcastCursor: number | null;
};

export type RestoreEntryVersionsResult = {
	message: EntryVersionsRestoredMessage;
	broadcastCursor: number | null;
};

export type DeletedEntriesPurgeResult = {
	message: DeletedEntriesPurgedMessage;
	candidateBlobIds: string[];
};
