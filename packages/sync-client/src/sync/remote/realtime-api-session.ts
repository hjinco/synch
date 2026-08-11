import type {
  CommitAcceptedResult,
  CommitMutationPayload,
  CommitMutationsResult,
  DeletedEntriesPurgedResponse,
  DeletedEntriesResponse,
  DeletedEntryPageCursor,
  EntryVersionPageCursor,
  EntryVersionRestoredResponse,
  EntryVersionsRestoredResponse,
  EntryVersionsResponse,
  HelloAckMessage,
  PurgeDeletedEntryPayload,
  RealtimeSessionState,
  RestoreEntryVersionPayload,
  SyncPolicy,
  SyncRealtimeSession,
  SyncStorageStatus,
} from "./realtime-types";
import { SyncRealtimeError } from "./realtime-types";
import type { EntryStatePageCursor, ListEntryStatesResponse } from "./changes";
import type { SyncRealtimeSocketSession } from "./realtime-socket-session";

export function applySessionStorageLimit(
  status: SyncStorageStatus,
  storageLimitBytes: number,
): SyncStorageStatus {
  return {
    storageUsedBytes: status.storageUsedBytes,
    storageLimitBytes,
  };
}

export class SyncRealtimeApiSession implements SyncRealtimeSession {
  readonly serverCursor: number;

  constructor(
    private readonly transport: SyncRealtimeSocketSession,
    hello: HelloAckMessage,
    private readonly state: RealtimeSessionState,
  ) {
    this.serverCursor = hello.cursor;
  }

  get storageUsedBytes(): number {
    return this.state.storageStatus.storageUsedBytes;
  }

  get storageLimitBytes(): number {
    return this.state.storageStatus.storageLimitBytes;
  }

  get maxFileSizeBytes(): number {
    return this.state.policy.maxFileSizeBytes;
  }

  applyPolicyUpdate(policy: SyncPolicy, storageStatus: SyncStorageStatus): SyncStorageStatus {
    this.state.policy = policy;
    const nextStatus = applySessionStorageLimit(
      storageStatus,
      policy.storageLimitBytes,
    );
    this.state.storageStatus = nextStatus;
    return nextStatus;
  }

  watchStorageStatus(): void {
    this.transport.send({
      type: "watch_storage_status",
    });
  }

  unwatchStorageStatus(): void {
    this.transport.send({
      type: "unwatch_storage_status",
    });
  }

  async listEntryStates(input: {
    sinceCursor: number;
    targetCursor: number | null;
    after: EntryStatePageCursor | null;
    limit: number;
  }): Promise<ListEntryStatesResponse> {
    const message = await this.transport.request({
      type: "list_entry_states",
      sinceCursor: input.sinceCursor,
      targetCursor: input.targetCursor,
      after: input.after,
      limit: input.limit,
    });

    if (message.type !== "entry_states_listed") {
      throw new Error("list entry states did not produce an entry_states_listed response");
    }

    return {
      targetCursor: message.targetCursor,
      totalEntries: message.totalEntries,
      hasMore: message.hasMore,
      nextAfter: message.nextAfter,
      entries: message.entries,
    };
  }

  async listEntryVersions(input: {
    entryId: string;
    before: EntryVersionPageCursor | null;
    limit: number;
  }): Promise<EntryVersionsResponse> {
    const message = await this.transport.request({
      type: "list_entry_versions",
      entryId: input.entryId,
      before: input.before,
      limit: input.limit,
    });

    if (message.type !== "entry_versions_listed") {
      throw new Error("list entry versions did not produce an entry_versions_listed response");
    }

    return {
      entryId: message.entryId,
      versions: message.versions,
      hasMore: message.hasMore,
      nextBefore: message.nextBefore,
    };
  }

  async listDeletedEntries(input: {
    before: DeletedEntryPageCursor | null;
    limit: number;
  }): Promise<DeletedEntriesResponse> {
    const message = await this.transport.request({
      type: "list_deleted_entries",
      before: input.before,
      limit: input.limit,
    });

    if (message.type !== "deleted_entries_listed") {
      throw new Error("list deleted entries did not produce a deleted_entries_listed response");
    }

    return {
      entries: message.entries,
      hasMore: message.hasMore,
      nextBefore: message.nextBefore,
    };
  }

  async restoreEntryVersion(
    input: RestoreEntryVersionPayload,
  ): Promise<EntryVersionRestoredResponse> {
    const message = await this.transport.request({
      type: "restore_entry_version",
      entryId: input.entryId,
      versionId: input.versionId,
      baseRevision: input.baseRevision,
      op: input.op,
      blobId: input.blobId,
      encryptedMetadata: input.encryptedMetadata,
    });

    if (message.type !== "entry_version_restored") {
      throw new Error("restore entry version did not produce an entry_version_restored response");
    }

    return {
      entryId: message.entryId,
      restoredFromVersionId: message.restoredFromVersionId,
      restoredFromRevision: message.restoredFromRevision,
      cursor: message.cursor,
      revision: message.revision,
    };
  }

  async restoreEntryVersions(
    input: RestoreEntryVersionPayload[],
  ): Promise<EntryVersionsRestoredResponse> {
    const message = await this.transport.request({
      type: "restore_entry_versions",
      restores: input,
    });

    if (message.type !== "entry_versions_restored") {
      throw new Error("restore entry versions did not produce an entry_versions_restored response");
    }

    return {
      cursor: message.cursor,
      results: message.results,
    };
  }

  async purgeDeletedEntries(
    input: PurgeDeletedEntryPayload[],
  ): Promise<DeletedEntriesPurgedResponse> {
    const message = await this.transport.request({
      type: "purge_deleted_entries",
      entries: input,
    });

    if (message.type !== "deleted_entries_purged") {
      throw new Error("purge deleted entries did not produce a deleted_entries_purged response");
    }

    return {
      results: message.results,
    };
  }

  async detachLocalVault(): Promise<void> {
    const message = await this.transport.request({
      type: "detach_local_vault",
    });

    if (message.type !== "local_vault_detached") {
      throw new Error("local vault detach did not produce a local_vault_detached response");
    }
  }

  async commitMutation(mutation: CommitMutationPayload): Promise<CommitAcceptedResult> {
    const batch = await this.commitMutations([mutation]);
    const result = batch.results[0];
    if (!result) {
      throw new Error("commit batch returned no result");
    }

    if (result.status === "rejected") {
      throw new SyncRealtimeError(result.code, result.message, {
        expectedBaseRevision: result.expectedBaseRevision,
        receivedBaseRevision: result.receivedBaseRevision,
      });
    }
    return {
      cursor: result.cursor,
      entryId: result.entryId,
      revision: result.revision,
    };
  }

  async commitMutations(
    mutations: CommitMutationPayload[],
  ): Promise<CommitMutationsResult> {
    const message = await this.transport.request({
      type: "commit_mutations",
      mutations,
    });

    if (message.type !== "commit_mutations_committed") {
      throw new Error("commit batch did not produce a commit_mutations_committed response");
    }

    return {
      cursor: message.cursor,
      results: message.results,
    };
  }

  close(): void {
    this.transport.close();
  }
}
