import { preparePushBatches } from "./push-preparation-pipeline";
import { SyncWorkProgress } from "./work-progress";
import type { SyncOperationProgress } from "../runtime/user-visible-status";
import type { SyncBlobClient } from "../remote/blob-client";
import type { ConflictFileWriter } from "../core/conflict-file";
import {
  resolveSyncContentRuntime,
  type SyncContentRuntime,
  type SyncContentRuntimeDeps,
} from "../core/content-runtime";
import {
  createSyncCryptoContext,
  type SyncCryptoContext,
} from "../core/crypto";
import type { SyncTokenResponse } from "../remote/client";
import type {
  CommitMutationBatchResult,
  SyncRealtimeSession,
} from "../remote/realtime-client";
import type {
  AcceptedPushMutationRow,
  PendingMutationRow,
} from "../store/store";
import type {
  SyncCursorStore,
  SyncMutationStore,
} from "../store/ports";
import {
  type LocalFileReader,
  PushMutationCommitter,
  type PushConflictEvent,
  type PushMutationStore,
  type PreparedPushMutation,
} from "./push-mutation-committer";
import { PushBlobRetryCache } from "./push-blob-retry-cache";

const DEFAULT_PUSH_PREPARE_CONCURRENCY = 12;

export interface SyncPushServiceDeps extends SyncContentRuntimeDeps {
  getApiBaseUrl: () => string;
  getSyncToken: () => Promise<SyncTokenResponse>;
  getSyncStore: () => SyncPushStore | null;
  getRemoteVaultKey: () => Uint8Array;
  fileReader: LocalFileReader;
  conflictFileWriter?: ConflictFileWriter;
  blobClient: Pick<SyncBlobClient, "uploadBlob">;
  prepareConcurrency?: number;
  onProgress?: (progress: SyncOperationProgress) => Promise<void>;
  onConflict?: (event: PushConflictEvent) => void;
  onFileSizeBlockedFilesChange?: () => void;
  onFileSyncStarted?: (event: {
    operation: "upsert" | "delete";
    path: string;
  }) => void;
  onFileSyncCompleted?: (event: {
    operation: "upsert" | "delete";
    path: string;
    revision: number;
  }) => void;
  onFileSyncFailed?: (event: {
    operation: "upsert" | "delete";
    path: string;
    reason: string;
  }) => void;
  now?: () => number;
}

export interface SyncPushStore
  extends SyncCursorStore,
    Pick<
      SyncMutationStore,
      "listBlockedDirtyEntriesByReason" | "listDirtyEntries" | "updateDirtyEntry"
    >,
    PushMutationStore {}

export interface PushPendingMutationsResult {
  cursor: number;
  mutationsPushed: number;
  mutationsRequeued: number;
  filesCreatedOrUpdated: number;
  filesDeleted: number;
  conflictsCreated: number;
  shouldPullAfterPush: boolean;
  hasMore: boolean;
  stopReason?: "storage_quota_exceeded";
}

export class SyncPushService {
  private readonly remotelyStagedBlobIds = new Set<string>();
  private readonly blobRetryCache = new PushBlobRetryCache();
  private readonly contentRuntime: SyncContentRuntime;

  constructor(private readonly deps: SyncPushServiceDeps) {
    this.contentRuntime = resolveSyncContentRuntime(deps);
  }

  async pushPendingMutations(
    session: SyncRealtimeSession,
    onProgress = this.deps.onProgress ?? (async (_progress: SyncOperationProgress) => {}),
    shouldYield: () => boolean = () => false,
  ): Promise<PushPendingMutationsResult> {
    const store = this.deps.getSyncStore();
    if (!store) {
      throw new Error("Sync store is not initialized.");
    }

    const progress = new SyncWorkProgress("push");
    await onProgress(progress.snapshot());
    const token = await this.deps.getSyncToken();
    const startingCursor = await store.getCursor();
    let cursor = startingCursor;
    let checkpointCursor = startingCursor;
    let mutationsPushed = 0;
    let mutationsRequeued = 0;
    let filesCreatedOrUpdated = 0;
    let filesDeleted = 0;
    let conflictsCreated = 0;
    let fileSizeBlocked = 0;
    let shouldPullAfterPush = false;
    const acceptedCursors: number[] = [];
    // Allow one immediate retry after requeueing; repeated churn must use the
    // auto loop's retry backoff instead of keeping an unbounded drain alive.
    const requeuedEntries = new Set<string>();
    let requeueLimitReached = false;
    const recordRequeue = (entryId: string) => {
      if (requeuedEntries.has(entryId)) requeueLimitReached = true;
      requeuedEntries.add(entryId);
    };
    let hasMore = false;
    let stopAfterCurrentBatch = false;
    let stopReason: PushPendingMutationsResult["stopReason"];

    const remoteVaultKey = this.deps.getRemoteVaultKey();
    const syncCryptoContext = createSyncCryptoContext(remoteVaultKey);
    const mutationCommitter = this.createMutationCommitter(
      remoteVaultKey,
      syncCryptoContext,
    );
    try {
      for await (const preparedMutations of this.preparePendingMutations(
        mutationCommitter,
        store,
        token,
        session,
        progress,
        () => shouldYield() || shouldPullAfterPush || requeueLimitReached,
      )) {
        const committable: Array<{
          mutation: (typeof preparedMutations)[number]["mutation"];
          prepared: PreparedPushMutation;
          path: string;
        }> = [];

        for (const { mutation, prepared, path } of preparedMutations) {
          if (!prepared) {
            mutationsRequeued += 1;
            recordRequeue(mutation.entryId);
            this.deps.onFileSyncFailed?.({
              operation: mutation.op,
              path,
              reason: "requeued",
            });
            continue;
          }
          if ("skipped" in prepared) {
            this.deps.onFileSyncFailed?.({
              operation: mutation.op,
              path,
              reason: prepared.reason,
            });
            if (prepared.reason === "file_too_large") {
              fileSizeBlocked += 1;
            }
            if (prepared.reason === "storage_quota_exceeded") {
              stopAfterCurrentBatch = true;
              stopReason = "storage_quota_exceeded";
              break;
            }
            continue;
          }

          committable.push({ mutation, prepared, path });
        }

        if (committable.length === 0) {
          await onProgress(progress.snapshot());
          if (stopAfterCurrentBatch) {
            break;
          }
          continue;
        }

        let committed;
        try {
          committed = await session.commitMutations(
            committable.map(({ prepared }) => prepared.commitPayload),
          );
        } catch (error) {
          for (const { mutation, path } of committable) {
            this.deps.onFileSyncFailed?.({
              operation: mutation.op,
              path,
              reason: "commit_failed",
            });
          }
          throw error;
        }
        const resultsByMutationId = new Map(
          committed.results.map((result) => [result.mutationId, result]),
        );

        const acceptedPushMutations: AcceptedPushMutationRow[] = [];
        const acceptedFiles: Array<{
          operation: "upsert" | "delete";
          path: string;
          revision: number;
        }> = [];
        const rejectedPushMutations: Array<{
          mutation: (typeof committable)[number]["mutation"];
          result: Extract<CommitMutationBatchResult, { status: "rejected" }>;
          path: string;
        }> = [];
        for (const { mutation, prepared, path } of committable) {
          const batchResult = resultsByMutationId.get(mutation.mutationId);
          if (!batchResult) {
            throw new Error(`Commit batch did not include ${mutation.mutationId}.`);
          }

          if (batchResult.status === "accepted") {
            const acceptedPushMutation =
              mutationCommitter.buildAcceptedPushMutation(
                mutation,
                prepared,
                batchResult,
              );
            acceptedPushMutations.push(acceptedPushMutation);
            if (acceptedPushMutation.remoteBlobId) {
              // The coordinator made this blob live as part of accepting the
              // mutation. A replay after a local apply failure is idempotent,
              // and a redundant upload is rejected before reaching storage.
              this.remotelyStagedBlobIds.delete(acceptedPushMutation.remoteBlobId);
              this.blobRetryCache.delete(acceptedPushMutation.remoteBlobId);
            }
            cursor = Math.max(cursor, batchResult.cursor);
            acceptedCursors.push(batchResult.cursor);
            acceptedFiles.push({
              operation: mutation.op,
              path,
              revision: batchResult.revision,
            });
            filesCreatedOrUpdated += mutation.op === "upsert" ? 1 : 0;
            filesDeleted += mutation.op === "delete" ? 1 : 0;
            mutationsPushed += 1;
            requeuedEntries.delete(mutation.entryId);
            continue;
          }

          rejectedPushMutations.push({ mutation, result: batchResult, path });
        }

        try {
          await store.applyAcceptedPushBatch(acceptedPushMutations, {
            remoteVaultKey,
          });
        } catch (error) {
          for (const accepted of acceptedFiles) {
            this.deps.onFileSyncFailed?.({
              operation: accepted.operation,
              path: accepted.path,
              reason: "local_commit_failed",
            });
          }
          throw error;
        }
        progress.complete(acceptedPushMutations.map(({ mutation }) => mutation.mutationId));
        for (const accepted of acceptedFiles) {
          this.deps.onFileSyncCompleted?.(accepted);
        }

        mutationCommitter.forgetRemotelyStagedBlobsIfMissing(
          rejectedPushMutations.map(({ mutation, result }) => ({
            blobId: mutation.blobId,
            error: result,
          })),
        );

        for (const { mutation, result: batchResult, path } of rejectedPushMutations) {
          let result;
          try {
            result = await mutationCommitter.handleRejectedPreparedMutation(
              store,
              mutation,
              batchResult,
            );
          } catch (error) {
            this.deps.onFileSyncFailed?.({
              operation: mutation.op,
              path,
              reason: "rejected",
            });
            throw error;
          }
          conflictsCreated += result.conflictsCreated;
          shouldPullAfterPush = shouldPullAfterPush || result.shouldPullAfterPush;

          if (result.status === "stale") {
            this.deps.onFileSyncFailed?.({
              operation: mutation.op,
              path,
              reason: "stale_revision",
            });
            mutationsRequeued += 1;
            recordRequeue(mutation.entryId);
            stopAfterCurrentBatch = true;
            continue;
          }
          if (result.status === "conflict") {
            this.deps.onFileSyncFailed?.({
              operation: mutation.op,
              path,
              reason: "conflict",
            });
            continue;
          }
        }
        await onProgress(progress.snapshot());
        if (stopAfterCurrentBatch) {
          break;
        }
      }

      hasMore = (await store.listDirtyEntries(1)).length > 0;
      checkpointCursor = getContiguousAcceptedCursor(
        checkpointCursor,
        acceptedCursors,
      );
      if (checkpointCursor > startingCursor) {
        await store.setCursor(checkpointCursor);
      }
      shouldPullAfterPush =
        shouldPullAfterPush ||
        acceptedCursors.some((acceptedCursor) => acceptedCursor > checkpointCursor);
    } finally {
      syncCryptoContext.dispose();
    }

    if (requeueLimitReached && !shouldYield() && !shouldPullAfterPush) {
      throw new PushNoProgressError();
    }

    progress.seal();
    await onProgress(progress.snapshot());

    // TODO: Refresh file-size-blocked decorations when existing blocked files become syncable.
    if (fileSizeBlocked > 0) {
      this.deps.onFileSizeBlockedFilesChange?.();
    }

    return {
      cursor,
      mutationsPushed,
      mutationsRequeued,
      filesCreatedOrUpdated,
      filesDeleted,
      conflictsCreated,
      shouldPullAfterPush,
      hasMore,
      ...(stopReason ? { stopReason } : {}),
    };
  }

  async unblockFileSizeBlockedMutations(maxFileSizeBytes: number): Promise<number> {
    const store = this.deps.getSyncStore();
    if (!store) {
      throw new Error("Sync store is not initialized.");
    }

    const blocked = await store.listBlockedDirtyEntriesByReason("file_too_large");
    let unblocked = 0;
    for (const mutation of blocked) {
      if (!shouldUnblockFileSizeMutation(mutation, maxFileSizeBytes)) {
        continue;
      }

      await store.updateDirtyEntry({
        ...mutation,
        status: "pending",
        blockedReason: null,
        blockedEncryptedSizeBytes: null,
        blockedMaxFileSizeBytes: null,
      });
      unblocked += 1;
    }

    return unblocked;
  }

  private createMutationCommitter(
    remoteVaultKey: Uint8Array,
    syncCryptoContext: SyncCryptoContext,
  ): PushMutationCommitter {
    return new PushMutationCommitter({
      getApiBaseUrl: () => this.deps.getApiBaseUrl(),
      getRemoteVaultKey: () => remoteVaultKey,
      getSyncCryptoContext: () => syncCryptoContext,
      fileReader: this.deps.fileReader,
      conflictFileWriter: this.deps.conflictFileWriter,
      blobClient: this.deps.blobClient,
      remotelyStagedBlobIds: this.remotelyStagedBlobIds,
      blobRetryCache: this.blobRetryCache,
      contentRuntime: this.contentRuntime,
      onConflict: this.deps.onConflict,
      now: this.deps.now,
    });
  }

  private preparePendingMutations(
    mutationCommitter: PushMutationCommitter,
    store: SyncPushStore,
    token: SyncTokenResponse,
    session: SyncRealtimeSession,
    progress: SyncWorkProgress,
    shouldYield: () => boolean,
  ): AsyncGenerator<
    Array<{
      mutation: PendingMutationRow;
      prepared: Awaited<ReturnType<PushMutationCommitter["prepareMutationForCommit"]>>;
      path: string;
    }>
  > {
    return preparePushBatches(
      (limit, excluded) => store.listDirtyEntries(limit, excluded),
      this.deps.prepareConcurrency ?? DEFAULT_PUSH_PREPARE_CONCURRENCY,
      async (mutation) => {
        progress.register([mutation.mutationId]);
        let path = "<unavailable>";
        try {
          const prepared = await mutationCommitter.prepareMutationForCommit(
            store,
            token,
            mutation,
            session.maxFileSizeBytes,
            (metadata) => {
              path = metadata.path;
              this.deps.onFileSyncStarted?.({ operation: mutation.op, path });
            },
          );
          return { mutation, path, prepared };
        } catch (error) {
          this.deps.onFileSyncFailed?.({
            operation: mutation.op,
            path,
            reason: "prepare_failed",
          });
          throw error;
        }
      },
      shouldYield,
    );
  }
}

export class PushNoProgressError extends Error {
  constructor() {
    super("Push repeatedly requeued an entry without accepting it.");
    this.name = "PushNoProgressError";
  }
}

function getContiguousAcceptedCursor(
  currentCursor: number,
  acceptedCursors: number[],
): number {
  if (acceptedCursors.length === 0) {
    return currentCursor;
  }

  const remaining = new Set(acceptedCursors);
  let cursor = currentCursor;
  while (remaining.delete(cursor + 1)) {
    cursor += 1;
  }
  return cursor;
}

function shouldUnblockFileSizeMutation(
  mutation: PendingMutationRow,
  maxFileSizeBytes: number,
): boolean {
  if (maxFileSizeBytes === 0) {
    return true;
  }

  const encryptedSizeBytes = mutation.blockedEncryptedSizeBytes;
  return (
    typeof encryptedSizeBytes === "number" &&
    encryptedSizeBytes <= maxFileSizeBytes
  );
}
