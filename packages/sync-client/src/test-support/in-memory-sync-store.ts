import { decryptSyncMetadata, encryptSyncMetadata } from "../sync/core/crypto";
import type {
  AcceptedPushMutationRow,
  BaseSyncEntryRow,
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

interface EntryState {
  entryId: string;
  remote: RemoteSyncEntryRow | null;
  base: BaseSyncEntryRow;
  local: LocalSyncEntryRow | null;
  dirty: PendingMutationRow | null;
}

type TestSyncEntryInput = Omit<SyncEntryRow, "localMtime" | "localSize"> &
  Partial<Pick<SyncEntryRow, "localMtime" | "localSize">>;

export class InMemorySyncStore implements SyncStore {
  private connection: SyncConnection | null = null;
  private readonly entries = new Map<string, EntryState>();
  private readonly blobs = new Map<string, CachedSyncBlobRow>();

  constructor(private readonly localVaultId: string = crypto.randomUUID()) {
    this.connection = {
      localVaultId,
      remoteVaultId: "vault-1",
      lastPulledCursor: 0,
    };
  }

  async readLocalVaultId(): Promise<string> {
    return this.localVaultId;
  }

  async readSyncConnection(): Promise<SyncConnection | null> {
    return this.connection ? { ...this.connection } : null;
  }

  async writeSyncConnection(connection: SyncConnection): Promise<void> {
    const localVaultId = connection.localVaultId.trim();
    const remoteVaultId = connection.remoteVaultId.trim();
    if (!localVaultId || !remoteVaultId) {
      throw new Error("Local and remote vault IDs are required.");
    }
    if (localVaultId !== this.localVaultId) {
      throw new Error("Local sync store belongs to a different local vault.");
    }
    this.connection = {
      localVaultId,
      remoteVaultId,
      lastPulledCursor: connection.lastPulledCursor,
    };
  }

  async ensureEntry(entryId: string): Promise<void> {
    this.getOrCreateEntry(entryId);
  }

  async getRemoteStateById(entryId: string): Promise<RemoteSyncEntryRow | null> {
    return cloneRemote(this.entries.get(entryId)?.remote ?? null);
  }

  async getRemoteStateByPath(path: string): Promise<RemoteSyncEntryRow | null> {
    const state = this.findByVisibleRemotePath(path);
    return cloneRemote(state?.remote ?? null);
  }

  async listRemoteStates(): Promise<RemoteSyncEntryRow[]> {
    return sortRows(
      [...this.entries.values()].flatMap((state) =>
        state.remote ? [{ ...state.remote }] : [],
      ),
    );
  }

  async applyRemoteState(entry: RemoteSyncEntryRow): Promise<void> {
    const state = this.getOrCreateEntry(entry.entryId);
    state.remote = cloneRemote(entry);
    if (!state.dirty) {
      state.base = remoteToBase(entry);
    }
  }

  async clearRemoteState(entryId: string): Promise<void> {
    const state = this.entries.get(entryId);
    if (!state) return;
    state.remote = null;
    if (!state.local && !state.dirty) this.entries.delete(entryId);
  }

  async getLocalStateById(entryId: string): Promise<LocalSyncEntryRow | null> {
    return cloneLocal(this.entries.get(entryId)?.local ?? null);
  }

  async getLocalStateByPath(path: string): Promise<LocalSyncEntryRow | null> {
    const state = this.findByVisibleLocalPath(path);
    return cloneLocal(state?.local ?? null);
  }

  async listLocalStates(): Promise<LocalSyncEntryRow[]> {
    return sortRows(
      [...this.entries.values()].flatMap((state) =>
        state.local ? [{ ...state.local }] : [],
      ),
    );
  }

  async applyLocalState(entry: LocalSyncEntryRow): Promise<void> {
    this.getOrCreateEntry(entry.entryId).local = cloneLocal(entry);
  }

  async clearLocalState(entryId: string): Promise<void> {
    const state = this.entries.get(entryId);
    if (!state) return;
    state.local = null;
    if (!state.remote && !state.dirty) this.entries.delete(entryId);
  }

  async getEntryById(entryId: string): Promise<SyncEntryRow | null> {
    const state = this.entries.get(entryId);
    return state ? toCombinedEntry(state) : null;
  }

  async getEntryByPath(path: string): Promise<SyncEntryRow | null> {
    const local = this.findByVisibleLocalPath(path);
    if (local) return toCombinedEntry(local);
    const remote = this.findByVisibleRemotePath(path);
    if (!remote || (remote.local && remote.local.path !== path)) return null;
    return toCombinedEntry(remote);
  }

  async getEntryStateById(entryId: string): Promise<SyncEntryStateRow | null> {
    const state = this.entries.get(entryId);
    return state ? cloneEntryState(state) : null;
  }

  async listEntries(): Promise<SyncEntryRow[]> {
    return sortRows(
      [...this.entries.values()]
        .map(toCombinedEntry)
        .filter((entry): entry is SyncEntryRow => entry !== null),
    );
  }

  async countSyncProgress(): Promise<SyncProgressCounts> {
    let completedEntries = 0;
    let totalEntries = 0;
    for (const state of this.entries.values()) {
      const deleted = state.local?.deleted ?? state.remote?.deleted ?? true;
      if (!state.dirty && deleted) continue;
      totalEntries += 1;
      if (state.remote && state.remote.revision > 0 && !state.dirty) {
        completedEntries += 1;
      }
    }
    return { completedEntries, totalEntries };
  }

  async getOrCreateEntryId(path: string): Promise<string> {
    return (await this.getEntryByPath(path))?.entryId ?? crypto.randomUUID();
  }

  async upsertEntry(entry: TestSyncEntryInput): Promise<void> {
    this.entries.set(entry.entryId, {
      entryId: entry.entryId,
      remote: {
        entryId: entry.entryId,
        path: entry.path,
        revision: entry.revision,
        blobId: entry.blobId,
        hash: entry.hash,
        deleted: entry.deleted,
        updatedAt: entry.updatedAt,
      },
      base: {
        entryId: entry.entryId,
        path: entry.path,
        revision: entry.revision,
        blobId: entry.blobId,
        hash: entry.hash,
        deleted: entry.deleted,
      },
      local: {
        entryId: entry.entryId,
        path: entry.path,
        blobId: entry.blobId,
        hash: entry.hash,
        deleted: entry.deleted,
        updatedAt: entry.updatedAt,
        localMtime: entry.localMtime ?? null,
        localSize: entry.localSize ?? null,
      },
      dirty: null,
    });
  }

  async deleteEntry(entryId: string): Promise<void> {
    this.entries.delete(entryId);
  }

  async getCursor(): Promise<number> {
    return this.connection?.lastPulledCursor ?? 0;
  }

  async setCursor(cursor: number): Promise<void> {
    if (!this.connection) throw new Error("Sync connection is not initialized.");
    this.connection = { ...this.connection, lastPulledCursor: cursor };
  }

  async markEntryDirty(
    mutation: PendingMutationRow,
    options: MarkEntryDirtyOptions = {},
  ): Promise<void> {
    const normalized = normalizePendingMutation(mutation);
    if (options.requireBaseBlob) this.assertRequiredBaseBlob(normalized);
    const state = this.getOrCreateEntry(mutation.entryId);
    state.dirty = normalized;
    state.base = {
      entryId: state.entryId,
      path: state.remote?.path ?? state.base.path,
      revision: normalized.baseRevision,
      blobId: normalized.baseBlobId ?? null,
      hash: normalized.baseHash ?? null,
      deleted: state.remote?.deleted ?? state.base.deleted,
    };
  }

  async replaceDirtyEntry(
    mutation: PendingMutationRow,
    options: MarkEntryDirtyOptions = {},
  ): Promise<void> {
    await this.markEntryDirty(mutation, options);
  }

  async getDirtyEntryMutation(entryId: string): Promise<PendingMutationRow | null> {
    return cloneMutation(this.entries.get(entryId)?.dirty ?? null);
  }

  async listDirtyEntries(limit?: number, excludedEntryIds?: ReadonlySet<string>): Promise<PendingMutationRow[]> {
    const mutations = [...this.entries.values()]
      .flatMap((state) =>
        !excludedEntryIds?.has(state.entryId) && state.dirty && (state.dirty.status ?? "pending") === "pending"
          ? [cloneMutation(state.dirty)]
          : [],
      )
      .sort((left, right) =>
        left.createdAt !== right.createdAt
          ? left.createdAt - right.createdAt
          : left.entryId.localeCompare(right.entryId),
      );
    return limit === undefined ? mutations : mutations.slice(0, limit);
  }

  async listBlockedDirtyEntriesByReason(
    reason: PendingMutationBlockedReason,
  ): Promise<PendingMutationRow[]> {
    return [...this.entries.values()].flatMap((state) =>
      state.dirty?.status === "blocked" && state.dirty.blockedReason === reason
        ? [cloneMutation(state.dirty)]
        : [],
    );
  }

  async updateDirtyEntry(mutation: PendingMutationRow): Promise<void> {
    await this.markEntryDirty(mutation);
  }

  async unblockDirtyEntriesByReason(reason: PendingMutationBlockedReason): Promise<void> {
    for (const state of this.entries.values()) {
      if (state.dirty?.status !== "blocked" || state.dirty.blockedReason !== reason) {
        continue;
      }
      state.dirty = {
        ...state.dirty,
        status: "pending",
        blockedReason: null,
        blockedEncryptedSizeBytes: null,
        blockedMaxFileSizeBytes: null,
      };
    }
  }

  async clearDirtyEntryByMutationId(mutationId: string): Promise<void> {
    for (const state of this.entries.values()) {
      if (state.dirty?.mutationId === mutationId) {
        state.dirty = null;
        return;
      }
    }
  }

  async markEntryClean(entryId: string): Promise<void> {
    const state = this.entries.get(entryId);
    if (state) state.dirty = null;
  }

  async listReconcileEntryStates(): Promise<SyncReconcileEntryState[]> {
    return [...this.entries.values()].map((state) => ({
      entryId: state.entryId,
      remote: cloneRemote(state.remote),
      local: cloneLocal(state.local),
      dirty: cloneMutation(state.dirty),
    }));
  }

  async applyReconcileEntryUpdates(updates: SyncReconcileEntryUpdate[]): Promise<void> {
    for (const update of updates) {
      if (update.deleteEntry) {
        this.entries.delete(update.entryId);
        continue;
      }
      const state = this.getOrCreateEntry(update.entryId);
      if (update.dirty !== undefined) {
        if (update.dirty && update.requireBaseBlob) {
          this.assertRequiredBaseBlob(normalizePendingMutation(update.dirty));
        }
        state.dirty = cloneMutation(update.dirty);
      } else if (update.clearDirty) {
        state.dirty = null;
      }
      if (update.local) state.local = cloneLocal(update.local);
    }
  }

  async getBlob(blobId: string): Promise<CachedSyncBlobRow | null> {
    return cloneBlob(this.blobs.get(blobId) ?? null);
  }

  async putBlob(blob: CachedSyncBlobRow): Promise<void> {
    this.blobs.set(blob.blobId, cloneBlob(blob));
  }

  async applyAcceptedPushBatch(
    accepted: AcceptedPushMutationRow[],
    options: { remoteVaultKey: Uint8Array },
  ): Promise<void> {
    for (const item of accepted) {
      const state = this.getOrCreateEntry(item.mutation.entryId);
      const currentPending = cloneMutation(state.dirty);
      const remote: RemoteSyncEntryRow = {
        entryId: state.entryId,
        path: item.metadata.path,
        revision: item.acceptedRevision,
        blobId: item.mutation.op === "delete" ? null : item.remoteBlobId,
        hash: item.mutation.op === "delete" ? null : item.localHash,
        deleted: item.mutation.op === "delete",
        updatedAt: item.acceptedAt,
      };
      state.remote = remote;

      if (
        item.mutation.op === "upsert" &&
        (!state.local ||
          (state.local.hash === item.mutation.hash &&
            state.local.path === item.metadata.path))
      ) {
        state.local = {
          entryId: state.entryId,
          path: item.metadata.path,
          blobId: item.remoteBlobId,
          hash: item.localHash,
          deleted: false,
          updatedAt: item.acceptedAt,
          localMtime: state.local?.localMtime ?? null,
          localSize: state.local?.localSize ?? null,
        };
      }

      if (!currentPending || currentPending.mutationId === item.mutation.mutationId) {
        state.dirty = null;
        state.base = remoteToBase(remote);
      } else {
        const metadata = await decryptSyncMetadata(
          options.remoteVaultKey,
          currentPending.encryptedMetadata,
          mutationMetadataContext(currentPending),
        );
        const rebased = {
          ...currentPending,
          baseRevision: item.acceptedRevision,
          baseBlobId: item.remoteBlobId,
          baseHash: item.localHash,
        };
        state.dirty = {
          ...rebased,
          encryptedMetadata: await encryptSyncMetadata(
            options.remoteVaultKey,
            metadata,
            mutationMetadataContext(rebased),
          ),
        };
        state.base = remoteToBase(remote);
      }

      if (item.remoteCacheBlob) await this.putBlob(item.remoteCacheBlob);
    }
  }

  async flush(): Promise<void> {}
  async close(): Promise<void> {}

  private getOrCreateEntry(entryId: string): EntryState {
    const existing = this.entries.get(entryId);
    if (existing) return existing;
    const created: EntryState = {
      entryId,
      remote: null,
      base: {
        entryId,
        path: null,
        revision: 0,
        blobId: null,
        hash: null,
        deleted: true,
      },
      local: null,
      dirty: null,
    };
    this.entries.set(entryId, created);
    return created;
  }

  private findByVisibleRemotePath(path: string): EntryState | null {
    return (
      [...this.entries.values()].find(
        (state) => state.remote?.path === path && !state.remote.deleted,
      ) ?? null
    );
  }

  private findByVisibleLocalPath(path: string): EntryState | null {
    return (
      [...this.entries.values()].find(
        (state) => state.local?.path === path && !state.local.deleted,
      ) ?? null
    );
  }

  private assertRequiredBaseBlob(mutation: Required<PendingMutationRow>): void {
    if (!mutation.baseBlobId || !mutation.baseHash) return;
    const blob = this.blobs.get(mutation.baseBlobId);
    if (!blob || blob.hash !== mutation.baseHash) {
      throw new Error(
        `Dirty entry ${mutation.entryId} requires cached base blob ${mutation.baseBlobId}.`,
      );
    }
  }
}

export function createTestSyncStore(localVaultId?: string): InMemorySyncStore {
  return new InMemorySyncStore(localVaultId);
}

function toCombinedEntry(state: EntryState): SyncEntryRow | null {
  const source = state.local ?? state.remote;
  if (!source) return null;
  return {
    entryId: state.entryId,
    path: source.path,
    revision: state.remote?.revision ?? 0,
    blobId: source.blobId,
    hash: source.hash,
    deleted: source.deleted,
    updatedAt: source.updatedAt,
    localMtime: state.local?.localMtime ?? null,
    localSize: state.local?.localSize ?? null,
  };
}

function cloneEntryState(state: EntryState): SyncEntryStateRow {
  return {
    entryId: state.entryId,
    remote: cloneRemote(state.remote),
    base: { ...state.base },
    local: cloneLocal(state.local),
    dirty: cloneMutation(state.dirty),
  };
}

function remoteToBase(remote: RemoteSyncEntryRow): BaseSyncEntryRow {
  return {
    entryId: remote.entryId,
    path: remote.path,
    revision: remote.revision,
    blobId: remote.blobId,
    hash: remote.hash,
    deleted: remote.deleted,
  };
}

function normalizePendingMutation(
  mutation: PendingMutationRow,
): Required<PendingMutationRow> {
  const status = mutation.status ?? "pending";
  return {
    ...mutation,
    status,
    blockedReason:
      status === "blocked" ? (mutation.blockedReason ?? "file_too_large") : null,
    blockedEncryptedSizeBytes:
      status === "blocked" ? (mutation.blockedEncryptedSizeBytes ?? null) : null,
    blockedMaxFileSizeBytes:
      status === "blocked" ? (mutation.blockedMaxFileSizeBytes ?? null) : null,
    baseBlobId: mutation.baseBlobId ?? null,
    baseHash: mutation.baseHash ?? null,
  };
}

function mutationMetadataContext(mutation: PendingMutationRow) {
  return {
    entryId: mutation.entryId,
    revision: mutation.baseRevision + 1,
    op: mutation.op,
    blobId: mutation.blobId,
  };
}

function cloneRemote(entry: RemoteSyncEntryRow | null): RemoteSyncEntryRow | null {
  return entry ? { ...entry } : null;
}

function cloneLocal(entry: LocalSyncEntryRow | null): LocalSyncEntryRow | null {
  return entry ? { ...entry } : null;
}

function cloneMutation(entry: PendingMutationRow): PendingMutationRow;
function cloneMutation(entry: PendingMutationRow | null): PendingMutationRow | null;
function cloneMutation(entry: PendingMutationRow | null): PendingMutationRow | null {
  if (!entry) return null;
  const cloned = { ...entry };
  if ((cloned.status ?? "pending") === "pending") {
    delete cloned.status;
    delete cloned.blockedReason;
    delete cloned.blockedEncryptedSizeBytes;
    delete cloned.blockedMaxFileSizeBytes;
  }
  if (cloned.baseBlobId === null) delete cloned.baseBlobId;
  if (cloned.baseHash === null) delete cloned.baseHash;
  return cloned;
}

function cloneBlob(blob: CachedSyncBlobRow): CachedSyncBlobRow;
function cloneBlob(blob: CachedSyncBlobRow | null): CachedSyncBlobRow | null;
function cloneBlob(blob: CachedSyncBlobRow | null): CachedSyncBlobRow | null {
  return blob
    ? {
        ...blob,
        encryptedBytes: new Uint8Array(blob.encryptedBytes),
      }
    : null;
}

function sortRows<T extends { updatedAt: number; entryId: string }>(rows: T[]): T[] {
  return rows.sort((left, right) =>
    left.updatedAt !== right.updatedAt
      ? left.updatedAt - right.updatedAt
      : left.entryId.localeCompare(right.entryId),
  );
}
