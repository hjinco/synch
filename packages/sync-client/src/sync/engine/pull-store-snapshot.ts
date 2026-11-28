import type {
  SyncEntryStore,
  SyncLocalEntryStore,
  SyncMutationStore,
  SyncRemoteEntryStore,
} from "../store/ports";
import type {
  LocalSyncEntryRow,
  PendingMutationRow,
  RemoteSyncEntryRow,
} from "../store/store";
import type { PullApplicationTargets } from "./pull-application-groups";

interface PullSnapshotStore
  extends Pick<SyncEntryStore, "deleteEntry">,
    Pick<SyncLocalEntryStore, "getLocalStateById" | "clearLocalState" | "applyLocalState">,
    Pick<SyncRemoteEntryStore, "getRemoteStateById" | "clearRemoteState" | "applyRemoteState">,
    Pick<SyncMutationStore, "getDirtyEntryMutation" | "clearDirtyEntryByMutationId" | "markEntryDirty"> {}

interface SnapshotEntryState {
  remote: RemoteSyncEntryRow | null;
  local: LocalSyncEntryRow | null;
}

/**
 * Capture and restore under the application's state-coordinator keys. This
 * restores store state only; partially written vault files are reconciled on retry.
 */
export async function capturePullStoreSnapshot(
  store: PullSnapshotStore,
  targets: Pick<PullApplicationTargets, "entryStateIds" | "dirtyEntryIds">,
): Promise<{ restore(): Promise<void> }> {
  const entries = new Map<string, SnapshotEntryState>();
  for (const entryId of targets.entryStateIds) {
    entries.set(entryId, {
      remote: await store.getRemoteStateById(entryId),
      local: await store.getLocalStateById(entryId),
    });
  }

  const dirtyEntries = new Map<string, PendingMutationRow | null>();
  for (const entryId of targets.dirtyEntryIds) {
    dirtyEntries.set(entryId, await store.getDirtyEntryMutation(entryId));
  }

  return {
    async restore() {
      await restoreEntryStates(store, entries);
      await restoreDirtyEntries(store, dirtyEntries);
    },
  };
}

async function restoreEntryStates(
  store: PullSnapshotStore,
  entries: ReadonlyMap<string, SnapshotEntryState>,
): Promise<void> {
  // Release every affected path before reclaiming any, including rename cycles.
  for (const entryId of entries.keys()) {
    await store.clearRemoteState(entryId);
    await store.clearLocalState(entryId);
  }
  for (const [entryId, entry] of entries) {
    if (entry.remote) {
      await store.applyRemoteState(entry.remote);
    } else {
      await store.clearRemoteState(entryId);
    }
    if (entry.local) {
      await store.applyLocalState(entry.local);
    } else {
      await store.clearLocalState(entryId);
    }
    if (!entry.remote && !entry.local && !(await store.getDirtyEntryMutation(entryId))) {
      await store.deleteEntry(entryId);
    }
  }
}

async function restoreDirtyEntries(
  store: PullSnapshotStore,
  entries: ReadonlyMap<string, PendingMutationRow | null>,
): Promise<void> {
  for (const [entryId, mutation] of entries) {
    const current = await store.getDirtyEntryMutation(entryId);
    if (current) await store.clearDirtyEntryByMutationId(current.mutationId);
    if (mutation) await store.markEntryDirty(mutation);
  }
}
