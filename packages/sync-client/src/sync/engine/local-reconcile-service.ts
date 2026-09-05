import {
  resolveSyncContentRuntime,
  type SyncContentRuntime,
  type SyncContentRuntimeDeps,
} from "../core/content-runtime";
import { createSyncCryptoContext, type SyncCryptoContext } from "../core/crypto";
import {
  buildLocalDeleteMutation,
  buildLocalUpsertMutation,
} from "../core/mutation-queue";
import type {
  LocalSyncEntryRow,
  RemoteSyncEntryRow,
  SyncReconcileEntryState,
  SyncReconcileEntryUpdate,
} from "../store/store";
import type { SyncReconcileStore } from "../store/ports";
import type { SyncVaultFile, SyncVaultScanner } from "../vault/ports";
import { isAutoMergeTextPath } from "./text-merge-policy";

const DEFAULT_RECONCILE_HASH_CONCURRENCY = 8;

export type LocalSyncFile = SyncVaultFile;
export type LocalFileScanner = SyncVaultScanner;

export interface SyncLocalReconcileServiceDeps extends SyncContentRuntimeDeps {
  getSyncStore: () => SyncLocalReconcileStore | null;
  getRemoteVaultKey: () => Uint8Array;
  scanner: LocalFileScanner;
  shouldSyncPath(path: string): boolean;
  hashConcurrency?: number;
}

export type SyncLocalReconcileStore = SyncReconcileStore;

export interface ReconcileOnceResult {
  filesScanned: number;
  filesQueuedForUpsert: number;
  filesQueuedForDelete: number;
}

export class SyncLocalReconcileService {
  private readonly contentRuntime: SyncContentRuntime;

  constructor(private readonly deps: SyncLocalReconcileServiceDeps) {
    this.contentRuntime = resolveSyncContentRuntime(deps);
  }

  async reconcileOnce(): Promise<ReconcileOnceResult> {
    const store = this.requireStore();
    const remoteVaultKey = this.deps.getRemoteVaultKey();
    const metadataCrypto = createSyncCryptoContext(remoteVaultKey);
    try {
      return await this.reconcileWithMetadataCrypto(
        store,
        metadataCrypto,
      );
    } finally {
      metadataCrypto.dispose();
    }
  }

  private async reconcileWithMetadataCrypto(
    store: SyncLocalReconcileStore,
    metadataCrypto: Pick<SyncCryptoContext, "encryptMetadata" | "decryptMetadata">,
  ): Promise<ReconcileOnceResult> {
    const localFiles = await this.deps.scanner.listFiles();
    const localPaths = new Set<string>();
    for (const file of localFiles) {
      localPaths.add(file.path);
    }
    const snapshot = await store.listReconcileEntryStates();
    const { retained, cleanupUpdates } = this.filterKnownEntries(snapshot);
    const localByPath = indexLocalEntriesByPath(retained);
    const remoteById = indexRemoteEntriesById(retained);
    const visibleRemoteByPath = indexVisibleRemoteEntriesByPath(retained);
    const pendingDeleteEntriesByPath = await this.indexPendingDeleteEntriesByPath(
      metadataCrypto,
      retained,
    );
    const renameCandidates = new Map<string, LocalSyncEntryRow[]>();
    const reusedEntryIds = new Set<string>();
    const updates: SyncReconcileEntryUpdate[] = [...cleanupUpdates];
    let filesQueuedForUpsert = 0;
    let filesQueuedForDelete = 0;

    for (const state of retained) {
      const entry = state.local;
      if (!entry) {
        continue;
      }
      if (entry.deleted || !entry.path || localPaths.has(entry.path) || !entry.hash) {
        continue;
      }

      const bucket = renameCandidates.get(entry.hash) ?? [];
      bucket.push(entry);
      renameCandidates.set(entry.hash, bucket);
    }

    const hashInputs: ReconcileHashInput[] = [];
    for (const file of localFiles) {
      const existing = localByPath.get(file.path) ?? null;
      const pendingDeleteEntry = pendingDeleteEntriesByPath.get(file.path) ?? null;
      const existingHasPendingDelete =
        !!existing && pendingDeleteEntry?.entryId === existing.entryId;
      const restoredDeletedEntry = existing ? null : pendingDeleteEntry;
      if (!existingHasPendingDelete && canSkipHash(existing, file)) {
        continue;
      }

      hashInputs.push({
        file,
        existing,
        existingHasPendingDelete,
        restoredDeletedEntry,
      });
    }

    const hashedFiles = await mapWithConcurrency(
      hashInputs,
      this.deps.hashConcurrency ?? DEFAULT_RECONCILE_HASH_CONCURRENCY,
      async (input) => {
        const { hash } = await this.contentRuntime.readAndHash(
          input.file.size,
          input.file.readBytes,
        );
        return {
          ...input,
          hash,
        };
      },
    );

    for (const {
      file,
      existing,
      existingHasPendingDelete,
      restoredDeletedEntry,
      hash,
    } of hashedFiles) {
      if (
        existing &&
        !existingHasPendingDelete &&
        !existing.deleted &&
        existing.hash === hash
      ) {
        updates.push({
          entryId: existing.entryId,
          local: {
            ...existing,
            localMtime: file.mtime,
            localSize: file.size,
          },
        });
        continue;
      }

      const renameMatch =
        !existing && !restoredDeletedEntry
          ? takeRenameCandidate(renameCandidates, hash)
          : null;
      const entry = existing ?? restoredDeletedEntry ?? renameMatch;
      if (renameMatch) {
        reusedEntryIds.add(renameMatch.entryId);
      }
      const remote = entry
        ? remoteById.get(entry.entryId) ?? null
        : visibleRemoteByPath.get(file.path) ?? null;
      const entryId = entry?.entryId ?? remote?.entryId ?? crypto.randomUUID();

      const queued = await buildLocalUpsertMutation({
        metadataCrypto,
        path: file.path,
        entryId,
        base: remote,
        previousLocal: entry,
        hash,
        requireBaseBlob: shouldRequireBaseBlob(file.path, remote),
      });
      updates.push({
        entryId: queued.entryId,
        dirty: queued.mutation,
        requireBaseBlob: shouldRequireBaseBlob(file.path, remote),
        local: {
          entryId: queued.entryId,
          path: file.path,
          blobId: queued.blobId,
          hash,
          deleted: false,
          updatedAt: Date.now(),
          localMtime: file.mtime,
          localSize: file.size,
        },
      });
      filesQueuedForUpsert += 1;
    }

    for (const state of retained) {
      const entry = state.local;
      if (!entry) {
        continue;
      }
      if (
        entry.deleted ||
        !entry.path ||
        localPaths.has(entry.path) ||
        reusedEntryIds.has(entry.entryId)
      ) {
        continue;
      }

      const remote = remoteById.get(entry.entryId) ?? null;
      if (!remote || remote.revision === 0) {
        updates.push({
          entryId: entry.entryId,
          clearDirty: true,
          deleteEntry: true,
        });
        continue;
      }

      const deletedPath = entry.path;
      const mutation = await buildLocalDeleteMutation({
        metadataCrypto,
        entryId: entry.entryId,
        base: remote,
        path: deletedPath,
      });
      updates.push({
        entryId: entry.entryId,
        dirty: mutation,
        local: {
          entryId: entry.entryId,
          path: null,
          blobId: null,
          hash: null,
          deleted: true,
          updatedAt: Date.now(),
          localMtime: null,
          localSize: null,
        },
      });
      filesQueuedForDelete += 1;
    }

    await applyReconcileUpdatesInChunks(store, updates);

    return {
      filesScanned: localFiles.length,
      filesQueuedForUpsert,
      filesQueuedForDelete,
    };
  }

  private requireStore(): SyncLocalReconcileStore {
    const store = this.deps.getSyncStore();
    if (!store) {
      throw new Error("Sync store is not initialized.");
    }

    return store;
  }

  private filterKnownEntries(
    entries: SyncReconcileEntryState[],
  ): {
    retained: SyncReconcileEntryState[];
    cleanupUpdates: SyncReconcileEntryUpdate[];
  } {
    const retained: SyncReconcileEntryState[] = [];
    const cleanupUpdates: SyncReconcileEntryUpdate[] = [];

    for (const entry of entries) {
      const local = entry.local;
      if (!local?.path || local.deleted || this.deps.shouldSyncPath(local.path)) {
        retained.push(entry);
        continue;
      }

      cleanupUpdates.push({
        entryId: entry.entryId,
        clearDirty: true,
        deleteEntry: !entry.remote || entry.remote.revision === 0,
      });
    }

    return { retained, cleanupUpdates };
  }

  private async indexPendingDeleteEntriesByPath(
    metadataCrypto: Pick<SyncCryptoContext, "decryptMetadata">,
    entries: SyncReconcileEntryState[],
  ): Promise<Map<string, LocalSyncEntryRow>> {
    const result = new Map<string, LocalSyncEntryRow>();

    for (const entry of entries) {
      const pending = entry.dirty;
      if (!pending || pending.op !== "delete") {
        continue;
      }

      const metadata = await metadataCrypto.decryptMetadata(pending.encryptedMetadata, {
        entryId: pending.entryId,
        revision: pending.baseRevision + 1,
        op: pending.op,
        blobId: pending.blobId,
      });
      const pendingEntry = entry.local;
      if (pendingEntry) {
        result.set(metadata.path, pendingEntry);
      }
    }

    return result;
  }
}

const RECONCILE_UPDATE_CHUNK_SIZE = 500;

interface ReconcileHashInput {
  file: LocalSyncFile;
  existing: LocalSyncEntryRow | null;
  existingHasPendingDelete: boolean;
  restoredDeletedEntry: LocalSyncEntryRow | null;
}

function canSkipHash(
  existing: LocalSyncEntryRow | null,
  file: LocalSyncFile,
): boolean {
  return (
    !!existing &&
    !existing.deleted &&
    !!existing.hash &&
    existing.localMtime === file.mtime &&
    existing.localSize === file.size
  );
}

function takeRenameCandidate(
  candidates: Map<string, LocalSyncEntryRow[]>,
  hash: string,
): LocalSyncEntryRow | null {
  const bucket = candidates.get(hash);
  if (!bucket || bucket.length === 0) {
    return null;
  }

  const match = bucket.shift() ?? null;
  if (bucket.length === 0) {
    candidates.delete(hash);
  }

  return match;
}

function indexLocalEntriesByPath(
  entries: SyncReconcileEntryState[],
): Map<string, LocalSyncEntryRow> {
  const result = new Map<string, LocalSyncEntryRow>();
  for (const entry of entries) {
    const local = entry.local;
    if (local?.path && !local.deleted) {
      result.set(local.path, local);
    }
  }
  return result;
}

function indexRemoteEntriesById(
  entries: SyncReconcileEntryState[],
): Map<string, RemoteSyncEntryRow> {
  const result = new Map<string, RemoteSyncEntryRow>();
  for (const entry of entries) {
    if (entry.remote) {
      result.set(entry.entryId, entry.remote);
    }
  }
  return result;
}

function indexVisibleRemoteEntriesByPath(
  entries: SyncReconcileEntryState[],
): Map<string, RemoteSyncEntryRow> {
  const result = new Map<string, RemoteSyncEntryRow>();
  for (const entry of entries) {
    const remote = entry.remote;
    if (!remote?.path || remote.deleted) {
      continue;
    }
    if (entry.local && entry.local.path !== remote.path) {
      continue;
    }
    result.set(remote.path, remote);
  }
  return result;
}

async function applyReconcileUpdatesInChunks(
  store: SyncLocalReconcileStore,
  updates: SyncReconcileEntryUpdate[],
): Promise<void> {
  for (let index = 0; index < updates.length; index += RECONCILE_UPDATE_CHUNK_SIZE) {
    await store.applyReconcileEntryUpdates(
      updates.slice(index, index + RECONCILE_UPDATE_CHUNK_SIZE),
    );
  }
}

function shouldRequireBaseBlob(
  path: string,
  remote: RemoteSyncEntryRow | null,
): boolean {
  return !!remote && !remote.deleted && !!remote.blobId && isAutoMergeTextPath(path);
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
  const normalizedConcurrency = Number.isFinite(concurrency) ? Math.floor(concurrency) : 1;
  const workerCount = Math.max(1, Math.min(normalizedConcurrency, items.length));

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
