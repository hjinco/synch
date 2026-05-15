import type { Plugin } from "obsidian";

import type {
  AcceptedPushMutationRow,
  CachedSyncBlobRow,
  LocalSyncEntryRow,
  MarkEntryDirtyOptions,
  PendingMutationBlockedReason,
  PendingMutationRow,
  RemoteSyncEntryRow,
  SyncConnection,
  SyncEntryRow,
  SyncEntryStateRow,
  SyncProgressCounts,
  SyncReconcileEntryState,
  SyncReconcileEntryUpdate,
  SyncStore,
} from "../sync/store/store";
import { decryptSyncMetadata, encryptSyncMetadata } from "../sync/core/crypto";

export function createTestPlugin(): Plugin {
  let data: unknown = null;
  const localStorage = new Map<string, unknown>();
  const directories = new Set([".obsidian/plugins/synch"]);
  const files = new Map<string, string | Uint8Array>();

  return {
    manifest: {
      dir: ".obsidian/plugins/synch",
    },
    app: {
      loadLocalStorage(key: string): unknown | null {
        return localStorage.get(key) ?? null;
      },
      saveLocalStorage(key: string, value: unknown | null): void {
        if (value === null) {
          localStorage.delete(key);
          return;
        }

        localStorage.set(key, value);
      },
      vault: {
        getFiles(): [] {
          return [];
        },
        adapter: {
          async exists(path: string): Promise<boolean> {
            return directories.has(path) || files.has(path);
          },
          async stat(path: string): Promise<{ type: "file" | "folder"; ctime: number; mtime: number; size: number } | null> {
            const file = files.get(path);
            if (file !== undefined) {
              return {
                type: "file",
                ctime: 1,
                mtime: 1,
                size: typeof file === "string" ? file.length : file.byteLength,
              };
            }

            if (directories.has(path)) {
              return {
                type: "folder",
                ctime: 1,
                mtime: 1,
                size: 0,
              };
            }

            return null;
          },
          async list(path: string): Promise<{ files: string[]; folders: string[] }> {
            const prefix = path ? `${path}/` : "";
            const childFiles = new Set<string>();
            const childFolders = new Set<string>();

            for (const filePath of files.keys()) {
              if (!filePath.startsWith(prefix)) {
                continue;
              }

              const rest = filePath.slice(prefix.length);
              const slashIndex = rest.indexOf("/");
              if (slashIndex < 0) {
                childFiles.add(filePath);
              } else {
                childFolders.add(`${prefix}${rest.slice(0, slashIndex)}`);
              }
            }

            for (const folderPath of directories) {
              if (folderPath === path || !folderPath.startsWith(prefix)) {
                continue;
              }

              const rest = folderPath.slice(prefix.length);
              const slashIndex = rest.indexOf("/");
              childFolders.add(
                slashIndex < 0
                  ? folderPath
                  : `${prefix}${rest.slice(0, slashIndex)}`,
              );
            }

            return {
              files: [...childFiles].sort((left, right) => left.localeCompare(right)),
              folders: [...childFolders].sort((left, right) => left.localeCompare(right)),
            };
          },
          async read(path: string): Promise<string> {
            const file = files.get(path);
            if (typeof file !== "string") {
              throw new Error(`missing test file: ${path}`);
            }

            return file;
          },
          async readBinary(path: string): Promise<ArrayBuffer> {
            const file = files.get(path);
            if (!(file instanceof Uint8Array)) {
              throw new Error(`missing test file: ${path}`);
            }

            return file.slice().buffer;
          },
          async write(path: string, value: string): Promise<void> {
            files.set(path, value);
          },
          async writeBinary(path: string, value: ArrayBuffer): Promise<void> {
            files.set(path, new Uint8Array(value));
          },
          async rename(oldPath: string, newPath: string): Promise<void> {
            const value = files.get(oldPath);
            if (value === undefined) {
              throw new Error(`missing test file: ${oldPath}`);
            }
            files.delete(oldPath);
            files.set(newPath, value);
          },
          async remove(path: string): Promise<void> {
            files.delete(path);
          },
          async mkdir(path: string): Promise<void> {
            directories.add(path);
          },
        },
      },
    },
    async loadData(): Promise<unknown> {
      return data;
    },
    async saveData(value: unknown): Promise<void> {
      data = value;
    },
  } as unknown as Plugin;
}

export async function createInitializedTestSyncStore(): Promise<SyncStore> {
  const store = new InMemorySyncStore();
  await store.writeSyncConnection({
    localVaultId: await store.readLocalVaultId(),
    remoteVaultId: "vault-1",
    lastPulledCursor: 0,
  });
  return store;
}

class InMemorySyncStore implements SyncStore {
  private readonly localVaultId = crypto.randomUUID();
  private connection: SyncConnection | null = null;
  private readonly entries = new Set<string>();
  private readonly remoteEntries = new Map<string, RemoteSyncEntryRow>();
  private readonly localEntries = new Map<string, LocalSyncEntryRow>();
  private readonly pendingMutations = new Map<string, Required<PendingMutationRow>>();
  private readonly cachedBlobs = new Map<string, CachedSyncBlobRow>();

  async readLocalVaultId(): Promise<string> {
    return this.localVaultId;
  }

  async readSyncConnection(): Promise<SyncConnection | null> {
    return this.connection ? { ...this.connection } : null;
  }

  async writeSyncConnection(connection: SyncConnection): Promise<void> {
    this.connection = {
      localVaultId: connection.localVaultId.trim(),
      remoteVaultId: connection.remoteVaultId.trim(),
      lastPulledCursor: connection.lastPulledCursor,
    };
  }

  async ensureEntry(entryId: string): Promise<void> {
    this.entries.add(entryId);
  }

  async getRemoteStateById(entryId: string): Promise<RemoteSyncEntryRow | null> {
    return cloneOrNull(this.remoteEntries.get(entryId));
  }

  async getRemoteStateByPath(path: string): Promise<RemoteSyncEntryRow | null> {
    return cloneOrNull(findByPath(this.remoteEntries, path));
  }

  async listRemoteStates(): Promise<RemoteSyncEntryRow[]> {
    return sortEntryRows([...this.remoteEntries.values()].map(clone));
  }

  async applyRemoteState(entry: RemoteSyncEntryRow): Promise<void> {
    await this.ensureEntry(entry.entryId);
    this.remoteEntries.set(entry.entryId, clone(entry));
  }

  async clearRemoteState(entryId: string): Promise<void> {
    this.remoteEntries.delete(entryId);
  }

  async getLocalStateById(entryId: string): Promise<LocalSyncEntryRow | null> {
    return cloneOrNull(this.localEntries.get(entryId));
  }

  async getLocalStateByPath(path: string): Promise<LocalSyncEntryRow | null> {
    return cloneOrNull(findByPath(this.localEntries, path));
  }

  async listLocalStates(): Promise<LocalSyncEntryRow[]> {
    return sortEntryRows([...this.localEntries.values()].map(clone));
  }

  async applyLocalState(entry: LocalSyncEntryRow): Promise<void> {
    await this.ensureEntry(entry.entryId);
    this.localEntries.set(entry.entryId, clone(entry));
  }

  async clearLocalState(entryId: string): Promise<void> {
    this.localEntries.delete(entryId);
  }

  async getEntryById(entryId: string): Promise<SyncEntryRow | null> {
    return combineEntryRows(
      await this.getRemoteStateById(entryId),
      await this.getLocalStateById(entryId),
    );
  }

  async getEntryByPath(path: string): Promise<SyncEntryRow | null> {
    const local = await this.getLocalStateByPath(path);
    if (local) {
      return combineEntryRows(await this.getRemoteStateById(local.entryId), local);
    }

    const remote = await this.getRemoteStateByPath(path);
    if (!remote) {
      return null;
    }

    const remoteLocal = await this.getLocalStateById(remote.entryId);
    if (remoteLocal && remoteLocal.path !== path) {
      return null;
    }
    return combineEntryRows(remote, remoteLocal);
  }

  async getEntryStateById(entryId: string): Promise<SyncEntryStateRow | null> {
    if (!this.entries.has(entryId)) {
      return null;
    }

    const remote = cloneOrNull(this.remoteEntries.get(entryId));
    const local = cloneOrNull(this.localEntries.get(entryId));
    const dirty = await this.getDirtyEntryMutation(entryId);
    return {
      entryId,
      remote,
      base: {
        entryId,
        path: remote?.path ?? null,
        revision: dirty?.baseRevision ?? remote?.revision ?? 0,
        blobId: dirty?.baseBlobId ?? remote?.blobId ?? null,
        hash: dirty?.baseHash ?? remote?.hash ?? null,
        deleted: remote?.deleted ?? true,
      },
      local,
      dirty,
    };
  }

  async listEntries(): Promise<SyncEntryRow[]> {
    const rows: SyncEntryRow[] = [];
    for (const entryId of [...this.entries].sort()) {
      const entry = await this.getEntryById(entryId);
      if (entry) {
        rows.push(entry);
      }
    }
    return sortEntryRows(rows);
  }

  async countSyncProgress(): Promise<SyncProgressCounts> {
    const pendingEntryIds = new Set(
      [...this.pendingMutations.values()].map((mutation) => mutation.entryId),
    );
    let completedEntries = 0;
    let totalEntries = 0;
    for (const entryId of this.entries) {
      const remote = this.remoteEntries.get(entryId) ?? null;
      const local = this.localEntries.get(entryId) ?? null;
      const hasPendingMutation = pendingEntryIds.has(entryId);
      const deleted = local?.deleted ?? remote?.deleted ?? true;
      if (!hasPendingMutation && deleted) {
        continue;
      }

      totalEntries += 1;
      if ((remote?.revision ?? 0) > 0 && !hasPendingMutation) {
        completedEntries += 1;
      }
    }
    return { completedEntries, totalEntries };
  }

  async getOrCreateEntryId(path: string): Promise<string> {
    const existing = await this.getEntryByPath(path);
    return existing?.entryId ?? crypto.randomUUID();
  }

  async upsertEntry(entry: SyncEntryRow): Promise<void> {
    await this.applyRemoteState({
      entryId: entry.entryId,
      path: entry.path,
      revision: entry.revision,
      blobId: entry.blobId,
      hash: entry.hash,
      deleted: entry.deleted,
      updatedAt: entry.updatedAt,
    });
    await this.applyLocalState({
      entryId: entry.entryId,
      path: entry.path,
      blobId: entry.blobId,
      hash: entry.hash,
      deleted: entry.deleted,
      updatedAt: entry.updatedAt,
      localMtime: entry.localMtime,
      localSize: entry.localSize,
    });
  }

  async deleteEntry(entryId: string): Promise<void> {
    this.localEntries.delete(entryId);
    this.remoteEntries.delete(entryId);
    this.entries.delete(entryId);
    await this.markEntryClean(entryId);
  }

  async getCursor(): Promise<number> {
    return this.connection?.lastPulledCursor ?? 0;
  }

  async setCursor(cursor: number): Promise<void> {
    if (!this.connection) {
      throw new Error("Sync connection is not initialized.");
    }
    this.connection = { ...this.connection, lastPulledCursor: cursor };
  }

  async markEntryDirty(
    mutation: PendingMutationRow,
    options: MarkEntryDirtyOptions = {},
  ): Promise<void> {
    if (options.requireBaseBlob) {
      this.assertRequiredBaseBlob(mutation);
    }
    await this.ensureEntry(mutation.entryId);
    this.pendingMutations.set(mutation.mutationId, normalizePendingMutation(mutation));
  }

  async replaceDirtyEntry(
    mutation: PendingMutationRow,
    options: MarkEntryDirtyOptions = {},
  ): Promise<void> {
    if (options.requireBaseBlob) {
      this.assertRequiredBaseBlob(mutation);
    }
    await this.ensureEntry(mutation.entryId);
    for (const pending of [...this.pendingMutations.values()]) {
      if (pending.entryId === mutation.entryId) {
        this.pendingMutations.delete(pending.mutationId);
      }
    }
    this.pendingMutations.set(mutation.mutationId, normalizePendingMutation(mutation));
  }

  async getDirtyEntryMutation(entryId: string): Promise<PendingMutationRow | null> {
    const mutation = [...this.pendingMutations.values()]
      .filter((row) => row.entryId === entryId)
      .sort(comparePendingMutationsDescending)[0];
    return mutation ? toPendingMutationRow(mutation) : null;
  }

  async listDirtyEntries(limit?: number): Promise<PendingMutationRow[]> {
    return [...this.pendingMutations.values()]
      .filter((mutation) => mutation.status === "pending")
      .sort(comparePendingMutationsAscending)
      .slice(0, limit)
      .map(toPendingMutationRow);
  }

  async updateDirtyEntry(mutation: PendingMutationRow): Promise<void> {
    this.pendingMutations.set(mutation.mutationId, normalizePendingMutation(mutation));
  }

  async listBlockedDirtyEntriesByReason(
    reason: PendingMutationBlockedReason,
  ): Promise<PendingMutationRow[]> {
    return [...this.pendingMutations.values()]
      .filter(
        (mutation) =>
          mutation.status === "blocked" && mutation.blockedReason === reason,
      )
      .sort(comparePendingMutationsAscending)
      .map(toPendingMutationRow);
  }

  async unblockDirtyEntriesByReason(reason: PendingMutationBlockedReason): Promise<void> {
    for (const mutation of this.pendingMutations.values()) {
      if (mutation.status === "blocked" && mutation.blockedReason === reason) {
        this.pendingMutations.set(mutation.mutationId, {
          ...mutation,
          status: "pending",
          blockedReason: null,
          blockedEncryptedSizeBytes: null,
          blockedMaxFileSizeBytes: null,
        });
      }
    }
  }

  async clearDirtyEntryByMutationId(mutationId: string): Promise<void> {
    this.pendingMutations.delete(mutationId);
  }

  async markEntryClean(entryId: string): Promise<void> {
    for (const mutation of this.pendingMutations.values()) {
      if (mutation.entryId === entryId) {
        this.pendingMutations.delete(mutation.mutationId);
      }
    }
  }

  async listReconcileEntryStates(): Promise<SyncReconcileEntryState[]> {
    return [...this.entries].sort().map((entryId) => ({
      entryId,
      remote: cloneOrNull(this.remoteEntries.get(entryId)),
      local: cloneOrNull(this.localEntries.get(entryId)),
      dirty: cloneOrNull(
        [...this.pendingMutations.values()]
          .filter((mutation) => mutation.entryId === entryId)
          .sort(comparePendingMutationsDescending)[0],
      ),
    }));
  }

  async applyReconcileEntryUpdates(
    updates: SyncReconcileEntryUpdate[],
  ): Promise<void> {
    for (const update of updates) {
      if (update.deleteEntry) {
        await this.deleteEntry(update.entryId);
        continue;
      }

      await this.ensureEntry(update.entryId);
      if (update.dirty !== undefined) {
        if (update.dirty === null) {
          await this.markEntryClean(update.entryId);
        } else {
          await this.replaceDirtyEntry(update.dirty, {
            requireBaseBlob: update.requireBaseBlob,
          });
        }
      } else if (update.clearDirty) {
        await this.markEntryClean(update.entryId);
      }

      if (update.local) {
        await this.applyLocalState(update.local);
      }
    }
  }

  async getBlob(blobId: string): Promise<CachedSyncBlobRow | null> {
    const blob = this.cachedBlobs.get(blobId);
    return blob
      ? {
          blobId: blob.blobId,
          hash: blob.hash,
          encryptedBytes: new Uint8Array(blob.encryptedBytes),
          cachedAt: blob.cachedAt,
        }
      : null;
  }

  async putBlob(blob: CachedSyncBlobRow): Promise<void> {
    this.cachedBlobs.set(blob.blobId, {
      ...blob,
      role: blob.role ?? "base",
      refEntryId: blob.refEntryId ?? null,
      encryptedBytes: new Uint8Array(blob.encryptedBytes),
    });
  }

  async applyAcceptedPushBatch(
    accepted: AcceptedPushMutationRow[],
    options: { remoteVaultKey: Uint8Array },
  ): Promise<void> {
    for (const item of accepted) {
      const { mutation, metadata } = item;
      await this.applyRemoteState({
        entryId: mutation.entryId,
        path: metadata.path,
        revision: item.acceptedRevision,
        blobId: mutation.op === "delete" ? null : item.remoteBlobId,
        hash: mutation.op === "delete" ? null : item.localHash,
        deleted: mutation.op === "delete",
        updatedAt: item.acceptedAt,
      });

      const local = await this.getLocalStateById(mutation.entryId);
      if (
        mutation.op === "upsert" &&
        (!local || (local.hash === mutation.hash && local.path === metadata.path))
      ) {
        await this.applyLocalState({
          entryId: mutation.entryId,
          path: metadata.path,
          blobId: item.remoteBlobId,
          hash: item.localHash,
          deleted: false,
          updatedAt: item.acceptedAt,
          localMtime: local?.localMtime ?? null,
          localSize: local?.localSize ?? null,
        });
      }

      const currentPending = await this.getDirtyEntryMutation(mutation.entryId);
      if (!currentPending) {
        continue;
      }
      if (currentPending.mutationId === mutation.mutationId) {
        await this.clearDirtyEntryByMutationId(mutation.mutationId);
      } else {
        const pendingMetadata = await decryptSyncMetadata(
          options.remoteVaultKey,
          currentPending.encryptedMetadata,
          metadataContextFromMutation(currentPending),
        );
        await this.updateDirtyEntry({
          ...currentPending,
          baseRevision: item.acceptedRevision,
          baseBlobId: item.remoteBlobId,
          baseHash: item.localHash,
          encryptedMetadata: await encryptSyncMetadata(
            options.remoteVaultKey,
            pendingMetadata,
            metadataContextFromMutation({
              ...currentPending,
              baseRevision: item.acceptedRevision,
              baseBlobId: item.remoteBlobId,
              baseHash: item.localHash,
            }),
          ),
        });
      }

      if (item.remoteCacheBlob) {
        await this.putBlob(item.remoteCacheBlob);
      }
    }
  }

  async flush(): Promise<void> {}

  async close(): Promise<void> {}

  private assertRequiredBaseBlob(mutation: PendingMutationRow): void {
    if (!mutation.baseBlobId || !mutation.baseHash) {
      return;
    }

    const blob = this.cachedBlobs.get(mutation.baseBlobId);
    if (!blob || blob.hash !== mutation.baseHash) {
      throw new Error(
        `Dirty entry ${mutation.entryId} requires cached base blob ${mutation.baseBlobId}.`,
      );
    }
  }
}

function findByPath<T extends { path: string | null }>(
  rows: Map<string, T>,
  path: string,
): T | undefined {
  return [...rows.values()].find(
    (entry) =>
      entry.path === path &&
      (!("deleted" in entry) || (entry as { deleted: boolean }).deleted === false),
  );
}

function combineEntryRows(
  remote: RemoteSyncEntryRow | null,
  local: LocalSyncEntryRow | null,
): SyncEntryRow | null {
  if (!remote && !local) {
    return null;
  }

  return {
    entryId: local?.entryId ?? remote?.entryId ?? "",
    path: local ? local.path : (remote?.path ?? null),
    revision: remote?.revision ?? 0,
    blobId: local ? local.blobId : (remote?.blobId ?? null),
    hash: local ? local.hash : (remote?.hash ?? null),
    deleted: local ? local.deleted : (remote?.deleted ?? true),
    updatedAt: local?.updatedAt ?? remote?.updatedAt ?? 0,
    localMtime: local?.localMtime ?? null,
    localSize: local?.localSize ?? null,
  };
}

function normalizePendingMutation(mutation: PendingMutationRow): Required<PendingMutationRow> {
  const status = mutation.status ?? "pending";
  return {
    ...mutation,
    status,
    blockedReason: status === "blocked" ? (mutation.blockedReason ?? "file_too_large") : null,
    blockedEncryptedSizeBytes:
      status === "blocked" ? (mutation.blockedEncryptedSizeBytes ?? null) : null,
    blockedMaxFileSizeBytes:
      status === "blocked" ? (mutation.blockedMaxFileSizeBytes ?? null) : null,
    baseBlobId: mutation.baseBlobId ?? null,
    baseHash: mutation.baseHash ?? null,
  };
}

function toPendingMutationRow(row: Required<PendingMutationRow>): PendingMutationRow {
  const mutation: PendingMutationRow = {
    mutationId: row.mutationId,
    entryId: row.entryId,
    op: row.op,
    baseRevision: row.baseRevision,
    blobId: row.blobId,
    hash: row.hash,
    encryptedMetadata: row.encryptedMetadata,
    createdAt: row.createdAt,
  };
  if (row.baseBlobId !== null) {
    mutation.baseBlobId = row.baseBlobId;
  }
  if (row.baseHash !== null) {
    mutation.baseHash = row.baseHash;
  }
  if (row.status === "blocked") {
    mutation.status = row.status;
    mutation.blockedReason = row.blockedReason;
    mutation.blockedEncryptedSizeBytes = row.blockedEncryptedSizeBytes;
    mutation.blockedMaxFileSizeBytes = row.blockedMaxFileSizeBytes;
  }
  return mutation;
}

function sortEntryRows<T extends { updatedAt: number; entryId: string }>(rows: T[]): T[] {
  return [...rows].sort((left, right) => {
    if (left.updatedAt !== right.updatedAt) {
      return left.updatedAt - right.updatedAt;
    }
    return left.entryId.localeCompare(right.entryId);
  });
}

function comparePendingMutationsAscending(
  left: Required<PendingMutationRow>,
  right: Required<PendingMutationRow>,
): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt;
  }
  return left.mutationId.localeCompare(right.mutationId);
}

function comparePendingMutationsDescending(
  left: Required<PendingMutationRow>,
  right: Required<PendingMutationRow>,
): number {
  if (left.createdAt !== right.createdAt) {
    return right.createdAt - left.createdAt;
  }
  return right.mutationId.localeCompare(left.mutationId);
}

function metadataContextFromMutation(mutation: PendingMutationRow) {
  return {
    entryId: mutation.entryId,
    revision: mutation.baseRevision + 1,
    op: mutation.op,
    blobId: mutation.blobId,
  };
}

function clone<T>(value: T): T {
  return { ...value };
}

function cloneOrNull<T>(value: T | undefined): T | null {
  return value ? clone(value) : null;
}
