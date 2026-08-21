import type { SyncBlobClient } from "../remote/blob-client";
import type { ConflictFileWriter } from "../core/conflict-file";
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
  SyncProgressCounts,
} from "../store/store";
import type {
  SyncCursorStore,
  SyncEntryStore,
  SyncMutationStore,
  SyncStoreLifecycle,
} from "../store/ports";
import {
  type LocalFileReader,
  PushMutationCommitter,
  type PushConflictEvent,
  type PushMutationStore,
  type PreparedPushMutation,
} from "./push-mutation-committer";
import { metadataContextFromMutation } from "./push-mutation-shared";

const DEFAULT_PUSH_BATCH = 100;
const DEFAULT_PUSH_DRAIN_LIMIT = 1_000;
const DEFAULT_PUSH_PREPARE_CONCURRENCY = 12;

export interface SyncPushServiceDeps {
  getApiBaseUrl: () => string;
  getSyncToken: () => Promise<SyncTokenResponse>;
  getSyncStore: () => SyncPushStore | null;
  getRemoteVaultKey: () => Uint8Array;
  fileReader: LocalFileReader;
  conflictFileWriter?: ConflictFileWriter;
  blobClient: Pick<SyncBlobClient, "uploadBlob">;
  prepareConcurrency?: number;
  onProgress: (progress: SyncProgressCounts) => Promise<void>;
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
    Pick<SyncEntryStore, "countSyncProgress">,
    Pick<
      SyncMutationStore,
      "listBlockedDirtyEntriesByReason" | "listDirtyEntries" | "updateDirtyEntry"
    >,
    Pick<SyncStoreLifecycle, "flush">,
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

  constructor(private readonly deps: SyncPushServiceDeps) {}

  async pushPendingMutations(
    session: SyncRealtimeSession,
  ): Promise<PushPendingMutationsResult> {
    const store = this.deps.getSyncStore();
    if (!store) {
      throw new Error("Sync store is not initialized.");
    }

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
    let processedMutations = 0;
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
      while (processedMutations < DEFAULT_PUSH_DRAIN_LIMIT) {
        const remainingBudget = DEFAULT_PUSH_DRAIN_LIMIT - processedMutations;
        const pending = await store.listDirtyEntries(
          Math.min(DEFAULT_PUSH_BATCH, remainingBudget),
        );
        if (pending.length === 0) {
          hasMore = false;
          break;
        }

        const preparedMutations = await this.preparePendingMutations(
          mutationCommitter,
          syncCryptoContext,
          store,
          token,
          session,
          pending,
        );

        const committable: Array<{
          mutation: (typeof preparedMutations)[number]["mutation"];
          prepared: PreparedPushMutation;
          path: string;
        }> = [];

        for (const { mutation, prepared, path } of preparedMutations) {
          processedMutations += 1;

          if (!prepared) {
            mutationsRequeued += 1;
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
          await this.reportProgress(store);
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
        }> = [];
        for (const { mutation, prepared, path } of committable) {
          const batchResult = resultsByMutationId.get(mutation.mutationId);
          if (!batchResult) {
            throw new Error(`Commit batch did not include ${mutation.mutationId}.`);
          }

          if (batchResult.status === "accepted") {
            const acceptedPushMutation =
              await mutationCommitter.buildAcceptedPushMutation(
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
            continue;
          }

          rejectedPushMutations.push({ mutation, result: batchResult });
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
        for (const accepted of acceptedFiles) {
          this.deps.onFileSyncCompleted?.(accepted);
        }

        mutationCommitter.forgetRemotelyStagedBlobsIfMissing(
          rejectedPushMutations.map(({ mutation, result }) => ({
            blobId: mutation.blobId,
            error: result,
          })),
        );

        for (const { mutation, result: batchResult } of rejectedPushMutations) {
          const path = committable.find(
            (item) => item.mutation.mutationId === mutation.mutationId,
          )?.path ?? "<unavailable>";
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
            stopAfterCurrentBatch = true;
            continue;
          }
          if (result.status === "requeued") {
            this.deps.onFileSyncFailed?.({
              operation: mutation.op,
              path,
              reason: "requeued",
            });
            mutationsRequeued += 1;
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
        await this.reportProgress(store);
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
      await store.flush();
    }

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

    if (unblocked > 0) {
      await store.flush();
    }

    return unblocked;
  }

  private async reportProgress(store: SyncPushStore): Promise<void> {
    const progress = await store.countSyncProgress();
    if (progress.totalEntries <= 0) {
      return;
    }

    await this.deps.onProgress(progress);
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
      onConflict: this.deps.onConflict,
      now: this.deps.now,
    });
  }

  private async preparePendingMutations(
    mutationCommitter: PushMutationCommitter,
    syncCryptoContext: SyncCryptoContext,
    store: SyncPushStore,
    token: SyncTokenResponse,
    session: SyncRealtimeSession,
    pending: PendingMutationRow[],
  ): Promise<
    Array<{
      mutation: (typeof pending)[number];
      prepared: Awaited<ReturnType<PushMutationCommitter["prepareMutationForCommit"]>>;
      path: string;
    }>
  > {
    return await mapWithConcurrency(
      pending,
      this.deps.prepareConcurrency ?? DEFAULT_PUSH_PREPARE_CONCURRENCY,
      async (mutation) => {
        let path = "<unavailable>";
        try {
          path = (
            await syncCryptoContext.decryptMetadata(
              mutation.encryptedMetadata,
              metadataContextFromMutation(mutation),
            )
          ).path;
          this.deps.onFileSyncStarted?.({ operation: mutation.op, path });
          return {
            mutation,
            path,
            prepared: await mutationCommitter.prepareMutationForCommit(
              store,
              token,
              mutation,
              session.maxFileSizeBytes,
            ),
          };
        } catch (error) {
          this.deps.onFileSyncFailed?.({
            operation: mutation.op,
            path,
            reason: "prepare_failed",
          });
          throw error;
        }
      },
    );
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

async function mapWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<U>,
): Promise<U[]> {
  if (items.length === 0) {
    return [];
  }

  const results = new Array<U>(items.length);
  let nextIndex = 0;
  let firstError: unknown = null;
  const workerCount = normalizeConcurrency(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length && !firstError) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          results[index] = await mapper(items[index]);
        } catch (error) {
          firstError = firstError ?? error;
        }
      }
    }),
  );

  if (firstError) {
    throw firstError instanceof Error
      ? firstError
      : new Error(typeof firstError === "string" ? firstError : "Concurrent operation failed");
  }

  return results;
}

function normalizeConcurrency(concurrency: number, itemCount: number): number {
  const normalizedConcurrency = Number.isFinite(concurrency) ? Math.floor(concurrency) : 1;
  return Math.max(1, Math.min(normalizedConcurrency, itemCount));
}
