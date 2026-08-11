import type { SyncTokenResponse } from "./client";
import type {
  EntryStatePageCursor,
  ListEntryStatesResponse,
} from "./changes";

export interface SyncRealtimeCallbacks {
  onCursorAdvanced(cursor: number): void;
  onStorageStatusUpdated(status: SyncStorageStatus): void;
  onPolicyUpdated(policy: SyncPolicy, storageStatus: SyncStorageStatus): void;
  onClose(event: { code: number; reason: string }): void;
  onError(error: Error): void;
}

export interface SyncStorageStatus {
  storageUsedBytes: number;
  storageLimitBytes: number;
}

export interface SyncPolicy {
  storageLimitBytes: number;
  maxFileSizeBytes: number;
}

export interface CommitMutationPayload {
  mutationId: string;
  entryId: string;
  op: "upsert" | "delete";
  baseRevision: number;
  blobId: string | null;
  encryptedMetadata: string;
}

export interface CommitAcceptedResult {
  cursor: number;
  entryId: string;
  revision: number;
}

export type CommitMutationBatchResult =
  | ({
      status: "accepted";
      mutationId: string;
    } & CommitAcceptedResult)
  | {
      status: "rejected";
      mutationId: string;
      entryId: string;
      code: string;
      message: string;
      expectedBaseRevision?: number;
      receivedBaseRevision?: number;
    };

export interface CommitMutationsResult {
  cursor: number;
  results: CommitMutationBatchResult[];
}

export interface RestoreEntryVersionPayload {
  entryId: string;
  versionId: string;
  baseRevision: number;
  op: "upsert" | "delete";
  blobId: string | null;
  encryptedMetadata: string;
}

export interface PurgeDeletedEntryPayload {
  entryId: string;
  revision: number;
}

export interface SyncRealtimeSession {
  serverCursor: number;
  storageUsedBytes: number;
  storageLimitBytes: number;
  maxFileSizeBytes: number;
  watchStorageStatus(): void;
  unwatchStorageStatus(): void;
  listEntryStates(input: {
    sinceCursor: number;
    targetCursor: number | null;
    after: EntryStatePageCursor | null;
    limit: number;
  }): Promise<ListEntryStatesResponse>;
  listEntryVersions(input: {
    entryId: string;
    before: EntryVersionPageCursor | null;
    limit: number;
  }): Promise<EntryVersionsResponse>;
  listDeletedEntries(input: {
    before: DeletedEntryPageCursor | null;
    limit: number;
  }): Promise<DeletedEntriesResponse>;
  restoreEntryVersion(
    input: RestoreEntryVersionPayload,
  ): Promise<EntryVersionRestoredResponse>;
  restoreEntryVersions(
    input: RestoreEntryVersionPayload[],
  ): Promise<EntryVersionsRestoredResponse>;
  purgeDeletedEntries(
    input: PurgeDeletedEntryPayload[],
  ): Promise<DeletedEntriesPurgedResponse>;
  detachLocalVault(): Promise<void>;
  commitMutation(mutation: CommitMutationPayload): Promise<CommitAcceptedResult>;
  commitMutations(mutations: CommitMutationPayload[]): Promise<CommitMutationsResult>;
  close(): void;
}

export interface EntryVersionPageCursor {
  capturedAt: number;
  versionId: string;
}

export interface DeletedEntryPageCursor {
  deletedAt: number;
  entryId: string;
}

export interface EntryVersion {
  versionId: string;
  sourceRevision: number;
  op: "upsert" | "delete";
  blobId: string | null;
  encryptedMetadata: string;
  reason: "auto" | "before_delete" | "before_restore" | "manual";
  capturedAt: number;
}

export interface EntryVersionsResponse {
  entryId: string;
  versions: EntryVersion[];
  hasMore: boolean;
  nextBefore: EntryVersionPageCursor | null;
}

export interface DeletedEntry {
  entryId: string;
  revision: number;
  encryptedMetadata: string;
  deletedAt: number;
}

export interface DeletedEntriesResponse {
  entries: DeletedEntry[];
  hasMore: boolean;
  nextBefore: DeletedEntryPageCursor | null;
}

export interface EntryVersionRestoredResponse {
  entryId: string;
  restoredFromVersionId: string;
  restoredFromRevision: number;
  cursor: number;
  revision: number;
}

export type RestoreEntryVersionBatchResult =
  | ({
      status: "accepted";
    } & EntryVersionRestoredResponse)
  | {
      status: "rejected";
      entryId: string;
      versionId: string;
      code: string;
      message: string;
      expectedBaseRevision?: number;
      receivedBaseRevision?: number;
    };

export interface EntryVersionsRestoredResponse {
  cursor: number;
  results: RestoreEntryVersionBatchResult[];
}

export type PurgeDeletedEntryBatchResult =
  | {
      status: "accepted";
      entryId: string;
    }
  | {
      status: "rejected";
      entryId: string;
      code: string;
      message: string;
      expectedRevision?: number;
    };

export interface DeletedEntriesPurgedResponse {
  results: PurgeDeletedEntryBatchResult[];
}

export class SyncRealtimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: {
      expectedBaseRevision?: number;
      receivedBaseRevision?: number;
    } = {},
  ) {
    super(message);
    this.name = "SyncRealtimeError";
  }
}

export class SyncRealtimeConnectionError extends Error {
  readonly cause?: unknown;

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = "SyncRealtimeConnectionError";
    this.cause = options.cause;
  }
}

export interface WebSocketFactory {
  create(url: string, protocols: string[]): WebSocket;
}

export interface SyncRealtimeClientOptions {
  requestTimeoutMs: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
}

export type ServerMessage =
  | {
      type: "hello_ack";
      requestId: string;
      cursor: number;
      policy: SyncPolicy;
      storageStatus: SyncStorageStatus;
    }
  | {
      type: "cursor_advanced";
      cursor: number;
    }
  | {
      type: "storage_status_updated";
      storageStatus: SyncStorageStatus;
    }
  | {
      type: "policy_updated";
      policy: SyncPolicy;
      storageStatus: SyncStorageStatus;
    }
  | {
      type: "commit_accepted";
      requestId: string;
      cursor: number;
      entryId: string;
      revision: number;
    }
  | {
      type: "commit_rejected";
      requestId: string;
      code: string;
      message: string;
      expectedBaseRevision?: number;
      receivedBaseRevision?: number;
    }
  | {
      type: "commit_mutations_committed";
      requestId: string;
      cursor: number;
      results: CommitMutationBatchResult[];
    }
  | {
      type: "commit_mutations_failed";
      requestId: string;
      code: string;
      message: string;
    }
  | ({
      type: "entry_states_listed";
      requestId: string;
    } & ListEntryStatesResponse)
  | {
      type: "entry_states_list_failed";
      requestId: string;
      code: string;
      message: string;
    }
  | ({
      type: "entry_versions_listed";
      requestId: string;
    } & EntryVersionsResponse)
  | {
      type: "entry_versions_list_failed";
      requestId: string;
      code: string;
      message: string;
    }
  | ({
      type: "deleted_entries_listed";
      requestId: string;
    } & DeletedEntriesResponse)
  | {
      type: "deleted_entries_list_failed";
      requestId: string;
      code: string;
      message: string;
    }
  | ({
      type: "entry_version_restored";
      requestId: string;
    } & EntryVersionRestoredResponse)
  | ({
      type: "entry_versions_restored";
      requestId: string;
    } & EntryVersionsRestoredResponse)
  | ({
      type: "deleted_entries_purged";
      requestId: string;
    } & DeletedEntriesPurgedResponse)
  | {
      type: "entry_restore_failed";
      requestId: string;
      code: string;
      message: string;
    }
  | {
      type: "deleted_entries_purge_failed";
      requestId: string;
      code: string;
      message: string;
    }
	  | {
	      type: "local_vault_detached";
	      requestId: string;
	    }
	  | {
      type: "heartbeat_ack";
      requestId: string;
    }
  | {
      type: "session_error";
      code: string;
      message: string;
    };

export type HelloAckMessage = Extract<ServerMessage, { type: "hello_ack" }>;
export type RealtimeSessionState = {
  storageStatus: SyncStorageStatus;
  policy: SyncPolicy;
};

export type { EntryStatePageCursor, ListEntryStatesResponse, SyncTokenResponse };
