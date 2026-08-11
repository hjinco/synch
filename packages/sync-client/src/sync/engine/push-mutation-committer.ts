import { writeConflictCopy } from "../core/conflict-file";
import {
  createSyncCryptoContext,
  type SyncCryptoContext,
} from "../core/crypto";
import type { SyncTokenResponse } from "../remote/client";
import {
  type CommitAcceptedResult,
  type CommitMutationBatchResult,
  SyncRealtimeError,
  type SyncRealtimeSession,
} from "../remote/realtime-client";
import type {
  AcceptedPushMutationRow,
  PendingMutationRow,
} from "../store/store";
import { PushMutationPreparer } from "./push-mutation-preparer";
import {
  isLocalAheadStaleRevision,
  isPullResolvableStaleRevision,
  isSkippedPushMutation,
  metadataContextFromMutation,
} from "./push-mutation-shared";
import { isAutoMergeTextPath } from "./text-merge-policy";
import type {
  PreparedPushMutation,
  PreparePushMutationResult,
  PushConflictEvent,
  PushMutationCommitResult,
  PushMutationCommitterDeps,
  PushMutationStore,
} from "./push-mutation-types";

export type {
  LocalFileReader,
  PreparedPushMutation,
  PreparePushMutationResult,
  PushConflictEvent,
  PushMutationCommitResult,
  PushMutationCommitterDeps,
  PushMutationStore,
  SkippedPushMutation,
} from "./push-mutation-types";

export class PushMutationCommitter {
  private readonly mutationPreparer: PushMutationPreparer;
  private fallbackCryptoContext: SyncCryptoContext | null = null;

  constructor(private readonly deps: PushMutationCommitterDeps) {
    this.mutationPreparer = new PushMutationPreparer(deps);
  }

  async commitMutation(
    store: PushMutationStore,
    token: SyncTokenResponse,
    session: SyncRealtimeSession,
    mutation: PendingMutationRow,
  ): Promise<PushMutationCommitResult> {
    const prepared = await this.mutationPreparer.prepareMutationForCommit(
      store,
      token,
      mutation,
      session.maxFileSizeBytes,
    );
    if (!prepared || isSkippedPushMutation(prepared)) {
      return {
        status: "requeued",
        filesCreatedOrUpdated: 0,
        filesDeleted: 0,
        conflictsCreated: 0,
        shouldPullAfterPush: false,
      };
    }

    return await this.commitPreparedMutation(store, session, mutation, prepared);
  }

  async prepareMutationForCommit(
    store: PushMutationStore,
    token: SyncTokenResponse,
    mutation: PendingMutationRow,
    maxFileSizeBytes: number,
    storageAvailableBytes: number | null = null,
  ): Promise<PreparePushMutationResult> {
    return await this.mutationPreparer.prepareMutationForCommit(
      store,
      token,
      mutation,
      maxFileSizeBytes,
      storageAvailableBytes,
    );
  }

  async commitPreparedMutation(
    store: PushMutationStore,
    session: SyncRealtimeSession,
    mutation: PendingMutationRow,
    prepared: PreparedPushMutation,
  ): Promise<PushMutationCommitResult> {
    let accepted;
    try {
      accepted = await session.commitMutation(prepared.commitPayload);
    } catch (error) {
      if (isPullResolvableStaleRevision(error)) {
        return {
          status: "stale",
          filesCreatedOrUpdated: 0,
          filesDeleted: 0,
          conflictsCreated: 0,
          shouldPullAfterPush: true,
        };
      }
      const handledConflict = await this.handleLocalAheadConflict(store, mutation, error);
      if (handledConflict) {
        return {
          status: "conflict",
          filesCreatedOrUpdated: 0,
          filesDeleted: 0,
          conflictsCreated: handledConflict.conflictPath ? 1 : 0,
          shouldPullAfterPush: false,
        };
      }

      throw error;
    }

    await store.applyAcceptedPushBatch(
      [await this.buildAcceptedPushMutation(mutation, prepared, accepted)],
      { remoteVaultKey: this.deps.getRemoteVaultKey() },
    );

    return {
      status: "accepted",
      accepted,
      filesCreatedOrUpdated: mutation.op === "upsert" ? 1 : 0,
      filesDeleted: mutation.op === "delete" ? 1 : 0,
      conflictsCreated: 0,
      shouldPullAfterPush: false,
    };
  }

  async applyAcceptedPreparedMutation(
    store: PushMutationStore,
    mutation: PendingMutationRow,
    prepared: PreparedPushMutation,
    accepted: CommitAcceptedResult,
  ): Promise<PushMutationCommitResult> {
    await store.applyAcceptedPushBatch(
      [await this.buildAcceptedPushMutation(mutation, prepared, accepted)],
      { remoteVaultKey: this.deps.getRemoteVaultKey() },
    );

    return {
      status: "accepted",
      accepted,
      filesCreatedOrUpdated: mutation.op === "upsert" ? 1 : 0,
      filesDeleted: mutation.op === "delete" ? 1 : 0,
      conflictsCreated: 0,
      shouldPullAfterPush: false,
    };
  }

  async handleRejectedPreparedMutation(
    store: PushMutationStore,
    mutation: PendingMutationRow,
    rejected: Extract<CommitMutationBatchResult, { status: "rejected" }>,
  ): Promise<PushMutationCommitResult> {
    if (isPullResolvableStaleRevision(rejected)) {
      return {
        status: "stale",
        filesCreatedOrUpdated: 0,
        filesDeleted: 0,
        conflictsCreated: 0,
        shouldPullAfterPush: true,
      };
    }
    const handledConflict = await this.handleLocalAheadConflict(
      store,
      mutation,
      rejected,
    );
    if (handledConflict) {
      return {
        status: "conflict",
        filesCreatedOrUpdated: 0,
        filesDeleted: 0,
        conflictsCreated: handledConflict.conflictPath ? 1 : 0,
        shouldPullAfterPush: false,
      };
    }

    throw new SyncRealtimeError(rejected.code, rejected.message);
  }

  async buildAcceptedPushMutation(
    mutation: PendingMutationRow,
    prepared: PreparedPushMutation,
    accepted: CommitAcceptedResult,
  ): Promise<AcceptedPushMutationRow> {
    const metadata = prepared.metadata;

    const acceptedAt = Date.now();
    const remoteCacheBlob =
      mutation.op === "upsert" &&
      isAutoMergeTextPath(metadata.path) &&
      prepared.commitPayload.blobId &&
      prepared.encryptedBytes
        ? {
            blobId: prepared.commitPayload.blobId,
            hash: prepared.localHash,
            encryptedBytes: prepared.encryptedBytes,
            role: "remote" as const,
            refEntryId: mutation.entryId,
            cachedAt: acceptedAt,
          }
        : null;

    return {
      mutation,
      metadata,
      acceptedRevision: accepted.revision,
      remoteBlobId: mutation.op === "delete" ? null : prepared.commitPayload.blobId,
      localHash: mutation.op === "delete" ? null : prepared.localHash,
      acceptedAt,
      remoteCacheBlob,
    };
  }

  private async handleLocalAheadConflict(
    store: PushMutationStore,
    mutation: PendingMutationRow,
    error: unknown,
  ): Promise<PushConflictEvent | null> {
    if (!isLocalAheadStaleRevision(error)) {
      return null;
    }

    const metadata = await this.getSyncCryptoContext().decryptMetadata(
      mutation.encryptedMetadata,
      metadataContextFromMutation(mutation),
    );
    const conflictPath =
      mutation.op === "upsert"
        ? await this.writeConflictCopy(
            metadata.path,
            await this.deps.fileReader.readBytes(metadata.path),
          )
        : null;

    await store.clearDirtyEntryByMutationId(mutation.mutationId);
    const event = {
      entryId: mutation.entryId,
      op: mutation.op,
      originalPath: metadata.path,
      conflictPath,
    };
    this.deps.onConflict?.(event);
    return event;
  }

  private getSyncCryptoContext(): SyncCryptoContext {
    if (this.deps.getSyncCryptoContext) {
      return this.deps.getSyncCryptoContext();
    }

    this.fallbackCryptoContext ??= createSyncCryptoContext(this.deps.getRemoteVaultKey());
    return this.fallbackCryptoContext;
  }

  private async writeConflictCopy(path: string, bytes: Uint8Array): Promise<string> {
    const writer = this.deps.conflictFileWriter;
    if (!writer) {
      throw new Error("Conflict file writer is not configured.");
    }

    return await writeConflictCopy(writer, path, bytes, this.deps.now);
  }
}
