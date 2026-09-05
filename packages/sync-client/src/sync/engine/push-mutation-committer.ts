import type { SyncedEntryMetadata } from "../core/content";
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
} from "../remote/realtime-client";
import type {
  AcceptedPushMutationRow,
  PendingMutationRow,
} from "../store/store";
import { PushMutationPreparer } from "./push-mutation-preparer";
import {
  isLocalAheadStaleRevision,
  isPullResolvableStaleRevision,
  metadataContextFromMutation,
} from "./push-mutation-shared";
import { isAutoMergeTextPath } from "./text-merge-policy";
import type {
  PreparedPushMutation,
  PreparePushMutationResult,
  PushConflictEvent,
  PushMutationRejectionResult,
  PushMutationCommitterDeps,
  PushMutationStore,
} from "./push-mutation-types";

export type {
  LocalFileReader,
  PreparedPushMutation,
  PreparePushMutationResult,
  PushConflictEvent,
  PushMutationRejectionResult,
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

  async prepareMutationForCommit(
    store: PushMutationStore,
    token: SyncTokenResponse,
    mutation: PendingMutationRow,
    maxFileSizeBytes: number,
    onMetadataReady?: (metadata: SyncedEntryMetadata) => void,
  ): Promise<PreparePushMutationResult> {
    return await this.mutationPreparer.prepareMutationForCommit(
      store,
      token,
      mutation,
      maxFileSizeBytes,
      onMetadataReady,
    );
  }

  async handleRejectedPreparedMutation(
    store: PushMutationStore,
    mutation: PendingMutationRow,
    rejected: Extract<CommitMutationBatchResult, { status: "rejected" }>,
  ): Promise<PushMutationRejectionResult> {
    if (isPullResolvableStaleRevision(rejected)) {
      return {
        status: "stale",
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
        conflictsCreated: handledConflict.conflictPath ? 1 : 0,
        shouldPullAfterPush: false,
      };
    }

    this.forgetRemotelyStagedBlobIfMissing(rejected, mutation.blobId);
    throw new SyncRealtimeError(rejected.code, rejected.message);
  }

  forgetRemotelyStagedBlobsIfMissing(
    rejections: ReadonlyArray<{ blobId: string | null; error: unknown }>,
  ): void {
    for (const { blobId, error } of rejections) {
      this.forgetRemotelyStagedBlobIfMissing(error, blobId);
    }
  }

  buildAcceptedPushMutation(
    mutation: PendingMutationRow,
    prepared: PreparedPushMutation,
    accepted: CommitAcceptedResult,
  ): AcceptedPushMutationRow {
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

  private forgetRemotelyStagedBlobIfMissing(
    error: unknown,
    blobId: string | null,
  ): void {
    if (!blobId || !isMissingRemoteBlobError(error)) {
      return;
    }
    this.deps.remotelyStagedBlobIds.delete(blobId);
    this.deps.blobRetryCache?.delete(blobId);
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

function isMissingRemoteBlobError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "blob_not_staged" || code === "blob_not_found";
}
