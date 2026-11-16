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
import type { PreparedManifestApplication } from "./pull-entry-state-internal";

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
  prepared: PreparedManifestApplication,
): Promise<{ restore(): Promise<void> }> {
  const plannedEntryIds = new Set<string>();
  for (const plan of prepared.plans) {
    plannedEntryIds.add(plan.state.entryId);
    if (plan.adoptedLocalEntry) plannedEntryIds.add(plan.adoptedLocalEntry.entry.entryId);
    if (plan.supersededPathOwner) plannedEntryIds.add(plan.supersededPathOwner.entryId);
  }
  for (const item of prepared.superseded) plannedEntryIds.add(item.state.entryId);

  const entryIds = new Set(plannedEntryIds);
  for (const item of prepared.skipped) entryIds.add(item.state.entryId);
  const entries = new Map<string, SnapshotEntryState>();
  for (const entryId of entryIds) {
    entries.set(entryId, {
      remote: await store.getRemoteStateById(entryId),
      local: await store.getLocalStateById(entryId),
    });
  }

  // Skipped entries only update remote/local state. Pending conflicts can mutate
  // other dirty entries, including entries without a visible local path.
  const dirtyEntryIds = new Set(plannedEntryIds);
  for (const conflict of prepared.pendingConflicts) dirtyEntryIds.add(conflict.pending.entryId);
  const dirtyEntries = new Map<string, PendingMutationRow | null>();
  for (const entryId of dirtyEntryIds) {
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
