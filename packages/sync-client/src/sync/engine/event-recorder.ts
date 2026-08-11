import { hashBytes } from "../core/content";
import { decryptSyncMetadata } from "../core/crypto";
import type { SyncEventGateLike } from "./event-gate";
import {
  queueLocalDeleteMutation,
  queueLocalUpsertMutation,
} from "../core/mutation-queue";
import type {
  LocalSyncEntryRow,
  RemoteSyncEntryRow,
} from "../store/store";
import type {
  SyncEntryStore,
  SyncLocalEntryStore,
  SyncMutationStore,
  SyncRemoteEntryStore,
  SyncStoreLifecycle,
} from "../store/ports";
import { isAutoMergeTextPath } from "./text-merge-policy";

export interface SyncEventRecorderDeps {
  getSyncStore: () => SyncEventRecorderStore | null;
  getRemoteVaultKey: () => Uint8Array;
  eventGate?: Pick<SyncEventGateLike, "isSuppressed">;
}

export interface SyncEventRecorderStore
  extends Pick<SyncEntryStore, "deleteEntry" | "getEntryByPath" | "getOrCreateEntryId">,
    Pick<
      SyncLocalEntryStore,
      "applyLocalState" | "getLocalStateById" | "getLocalStateByPath"
    >,
    Pick<
      SyncRemoteEntryStore,
      "getRemoteStateById" | "getRemoteStateByPath"
    >,
    Pick<
      SyncMutationStore,
      | "getDirtyEntryMutation"
      | "listDirtyEntries"
      | "markEntryClean"
      | "replaceDirtyEntry"
    >,
    Pick<SyncStoreLifecycle, "flush"> {}

export interface LocalFileStat {
  mtime: number;
  size: number;
}

export class SyncEventRecorder {
  constructor(private readonly deps: SyncEventRecorderDeps) {}

  async recordUpsert(
    path: string,
    bytes: Uint8Array,
    localStat: LocalFileStat | null = null,
  ): Promise<boolean> {
    if (this.isSuppressed(path)) {
      return false;
    }

    const store = this.requireStore();
    const existing =
      (await store.getLocalStateByPath(path)) ??
      (await this.findPendingDeleteLocalEntryByPath(store, path));
    const remote = existing
      ? await store.getRemoteStateById(existing.entryId)
      : await getVisibleRemoteEntryByPath(store, path);
    const entryId = existing?.entryId ?? remote?.entryId ?? (await store.getOrCreateEntryId(path));
    const hash = await hashBytes(bytes);
    if (existing && !existing.deleted && existing.hash === hash) {
      const pending = await store.getDirtyEntryMutation(existing.entryId);
      if (!pending || (pending.op === "upsert" && pending.hash === hash)) {
        if (
          localStat &&
          (existing.localMtime !== localStat.mtime || existing.localSize !== localStat.size)
        ) {
          await store.applyLocalState({
            ...existing,
            localMtime: localStat.mtime,
            localSize: localStat.size,
          });
          await store.flush();
        }
        return false;
      }
    }

    const queued = await queueLocalUpsertMutation(store, {
      remoteVaultKey: this.deps.getRemoteVaultKey(),
      path,
      entryId,
      base: remote,
      previousLocal: existing,
      hash,
      requireBaseBlob: shouldRequireBaseBlob(path, remote),
    });
    const nextEntry = buildLocalEntrySnapshot(existing, {
      entryId: queued.entryId,
      path,
      blobId: queued.blobId,
      hash,
      deleted: false,
      updatedAt: Date.now(),
      localMtime: localStat?.mtime ?? null,
      localSize: localStat?.size ?? null,
    });

    await store.applyLocalState(nextEntry);
    await store.flush();
    return true;
  }

  async recordRename(
    oldPath: string,
    nextPath: string,
    bytes: Uint8Array,
    localStat: LocalFileStat | null = null,
  ): Promise<boolean> {
    if (this.isSuppressed(oldPath) || this.isSuppressed(nextPath)) {
      return false;
    }

    const store = this.requireStore();
    const existing =
      (await store.getLocalStateByPath(oldPath)) ??
      (await store.getLocalStateByPath(nextPath));
    if (!existing) {
      return await this.recordUpsert(nextPath, bytes);
    }
    const remote = await store.getRemoteStateById(existing.entryId);

    const hash = await hashBytes(bytes);
    if (existing.path === nextPath && !existing.deleted && existing.hash === hash) {
      const pending = await store.getDirtyEntryMutation(existing.entryId);
      if (!pending || (pending.op === "upsert" && pending.hash === hash)) {
        if (
          localStat &&
          (existing.localMtime !== localStat.mtime || existing.localSize !== localStat.size)
        ) {
          await store.applyLocalState({
            ...existing,
            localMtime: localStat.mtime,
            localSize: localStat.size,
          });
          await store.flush();
        }
        return false;
      }
    }

    const queued = await queueLocalUpsertMutation(store, {
      remoteVaultKey: this.deps.getRemoteVaultKey(),
      path: nextPath,
      entryId: existing.entryId,
      base: remote,
      previousLocal: existing,
      hash,
      requireBaseBlob: shouldRequireBaseBlob(nextPath, remote),
    });
    await store.applyLocalState(
      buildLocalEntrySnapshot(existing, {
        path: nextPath,
        blobId: queued.blobId,
        hash,
        deleted: false,
        updatedAt: Date.now(),
        localMtime: localStat?.mtime ?? null,
        localSize: localStat?.size ?? null,
      }),
    );
    await store.flush();
    return true;
  }

  async recordDelete(path: string): Promise<boolean> {
    if (this.isSuppressed(path)) {
      return false;
    }

    const store = this.requireStore();
    const existing =
      (await store.getLocalStateByPath(path)) ??
      (await store.getRemoteStateByPath(path));
    if (!existing) {
      return false;
    }

    await store.markEntryClean(existing.entryId);
    const remote = await store.getRemoteStateById(existing.entryId);

    if (!remote || remote.revision === 0) {
      await store.deleteEntry(existing.entryId);
      await store.flush();
      return false;
    }

    await store.applyLocalState(
      buildLocalEntrySnapshot(await store.getLocalStateById(existing.entryId), {
        entryId: existing.entryId,
        path: null,
        blobId: null,
        hash: null,
        deleted: true,
        updatedAt: Date.now(),
        localMtime: null,
        localSize: null,
      }),
    );
    await queueLocalDeleteMutation(store, {
      remoteVaultKey: this.deps.getRemoteVaultKey(),
      entryId: existing.entryId,
      base: remote,
      path,
    });
    await store.flush();
    return true;
  }

  private isSuppressed(path: string): boolean {
    return this.deps.eventGate?.isSuppressed(path) ?? false;
  }

  private requireStore(): SyncEventRecorderStore {
    const store = this.deps.getSyncStore();
    if (!store) {
      throw new Error("Sync store is not initialized.");
    }

    return store;
  }

  private async findPendingDeleteLocalEntryByPath(
    store: SyncEventRecorderStore,
    path: string,
  ): Promise<LocalSyncEntryRow | null> {
    const remoteVaultKey = this.deps.getRemoteVaultKey();

    for (const pending of await store.listDirtyEntries()) {
      if (pending.op !== "delete") {
        continue;
      }

      const metadata = await decryptSyncMetadata(
        remoteVaultKey,
        pending.encryptedMetadata,
        {
          entryId: pending.entryId,
          revision: pending.baseRevision + 1,
          op: pending.op,
          blobId: pending.blobId,
        },
      );
      if (metadata.path !== path) {
        continue;
      }

      return await store.getLocalStateById(pending.entryId);
    }

    return null;
  }
}

function buildLocalEntrySnapshot(
  existing: LocalSyncEntryRow | RemoteSyncEntryRow | null,
  overrides: Partial<LocalSyncEntryRow> & Pick<LocalSyncEntryRow, "updatedAt" | "deleted">,
): LocalSyncEntryRow {
  return {
    entryId: overrides.entryId ?? existing?.entryId ?? crypto.randomUUID(),
    path: overrides.path !== undefined ? overrides.path : (existing?.path ?? null),
    blobId: overrides.blobId !== undefined ? overrides.blobId : (existing?.blobId ?? null),
    hash:
      overrides.hash !== undefined
        ? overrides.hash
        : (existing?.hash ?? null),
    deleted: overrides.deleted,
    updatedAt: overrides.updatedAt,
    localMtime:
      overrides.localMtime !== undefined
        ? overrides.localMtime
        : localMtimeOf(existing),
    localSize:
      overrides.localSize !== undefined
        ? overrides.localSize
        : localSizeOf(existing),
  };
}

function localMtimeOf(
  entry: LocalSyncEntryRow | RemoteSyncEntryRow | null,
): number | null {
  return entry && "localMtime" in entry ? entry.localMtime : null;
}

function localSizeOf(
  entry: LocalSyncEntryRow | RemoteSyncEntryRow | null,
): number | null {
  return entry && "localSize" in entry ? entry.localSize : null;
}

async function getVisibleRemoteEntryByPath(
  store: SyncEventRecorderStore,
  path: string,
): Promise<RemoteSyncEntryRow | null> {
  const visible = await store.getEntryByPath(path);
  return visible ? await store.getRemoteStateById(visible.entryId) : null;
}

function shouldRequireBaseBlob(
  path: string,
  remote: RemoteSyncEntryRow | null,
): boolean {
  return !!remote && !remote.deleted && !!remote.blobId && isAutoMergeTextPath(path);
}
