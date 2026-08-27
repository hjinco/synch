export type CommitMutationPayload = {
	mutationId: string;
	entryId: string;
	op: "upsert" | "delete";
	baseRevision: number;
	blobId: string | null;
	encryptedMetadata: string;
};

export type HelloMessage = {
	type: "hello";
	requestId: string;
	lastKnownCursor: number;
};

export type CommitMutationMessage = {
	type: "commit_mutation";
	requestId: string;
	mutation: CommitMutationPayload;
};

export type CommitMutationsMessage = {
	type: "commit_mutations";
	requestId: string;
	mutations: CommitMutationPayload[];
};

export type ListEntryStatesMessage = {
	type: "list_entry_states";
	requestId: string;
	sinceCursor: number;
	targetCursor: number | null;
	after: { updatedSeq: number; entryId: string } | null;
	limit: number;
};

export type ListEntryVersionsMessage = {
	type: "list_entry_versions";
	requestId: string;
	entryId: string;
	before: { capturedAt: number; versionId: string } | null;
	limit: number;
};

export type ListDeletedEntriesMessage = {
	type: "list_deleted_entries";
	requestId: string;
	before: { deletedAt: number; entryId: string } | null;
	limit: number;
};

export type RestoreEntryVersionMessage = {
	type: "restore_entry_version";
	requestId: string;
	entryId: string;
	versionId: string;
	baseRevision: number;
	op: "upsert" | "delete";
	blobId: string | null;
	encryptedMetadata: string;
};

export type RestoreEntryVersionsMessage = {
	type: "restore_entry_versions";
	requestId: string;
	restores: Array<Omit<RestoreEntryVersionMessage, "type" | "requestId">>;
};

export type PurgeDeletedEntriesMessage = {
	type: "purge_deleted_entries";
	requestId: string;
	entries: Array<{ entryId: string; revision: number }>;
};

export type DetachLocalVaultMessage = {
	type: "detach_local_vault";
	requestId: string;
};

export type HeartbeatMessage = { type: "heartbeat"; requestId: string };
export type WatchStorageStatusMessage = { type: "watch_storage_status" };
export type UnwatchStorageStatusMessage = { type: "unwatch_storage_status" };
export type WatchPresenceMessage = {
	type: "watch_presence";
	entryIds: string[];
};
export type UnwatchPresenceMessage = { type: "unwatch_presence" };
export type PresencePosition = {
	line: number;
	ch: number;
};
export type PresenceSelection = {
	anchor: PresencePosition;
	head: PresencePosition;
};
export type PresenceUpdateMessage = {
	type: "presence_update";
	entryId: string;
	selection: PresenceSelection;
};
export type PresenceClearMessage = { type: "presence_clear" };

export type ClientControlMessage =
	| HelloMessage
	| CommitMutationMessage
	| CommitMutationsMessage
	| ListEntryStatesMessage
	| ListEntryVersionsMessage
	| ListDeletedEntriesMessage
	| RestoreEntryVersionMessage
	| RestoreEntryVersionsMessage
	| PurgeDeletedEntriesMessage
	| DetachLocalVaultMessage
	| HeartbeatMessage
	| WatchStorageStatusMessage
	| UnwatchStorageStatusMessage
	| WatchPresenceMessage
	| UnwatchPresenceMessage
	| PresenceUpdateMessage
	| PresenceClearMessage;
