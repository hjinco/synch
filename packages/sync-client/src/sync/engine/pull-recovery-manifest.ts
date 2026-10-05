import type { EntryStatePageCursor } from "../remote/changes";
import { SyncRealtimeError, type SyncRealtimeSession } from "../remote/realtime-client";
import type { SyncCursorStore } from "../store/ports";
import type {
  PullEntryStateApplier,
  PullEntryStateManifestItem,
  PullEntryStateStore,
} from "./pull-entry-state-applier";

const RECOVERY_BATCH_SIZE = 100;

export class RecoveryPendingDependenciesError extends Error {
  constructor(readonly entryIds: string[]) {
    super("Recovery is waiting for pending local path changes to sync.");
    this.name = "RecoveryPendingDependenciesError";
  }
}

/** Read the selected entries and their path dependencies before any vault writes. */
export async function loadRecoveryManifest(
  session: SyncRealtimeSession,
  store: PullEntryStateStore & SyncCursorStore,
  entryIds: string[],
  deps: {
    applier: Pick<PullEntryStateApplier, "createManifestItems">;
    shouldApplyRemotePath?: (path: string, deleted: boolean) => boolean;
    onItems: (items: PullEntryStateManifestItem[]) => Promise<void>;
  },
): Promise<PullEntryStateManifestItem[]> {
  const startingCursor = await store.getCursor();
  const requested = new Set(entryIds);
  const queued = new Set(entryIds);
  const queue = [...queued];
  const manifest = new Map<string, PullEntryStateManifestItem>();
  const requiredOwners = new Map<string, number>();
  let targetCursor: number | null = null;

  for (let offset = 0; offset < queue.length;) {
    const batch = queue.slice(offset, offset + RECOVERY_BATCH_SIZE);
    offset += batch.length;
    const remaining = new Set(batch);
    const batchItems: PullEntryStateManifestItem[] = [];
    let after: EntryStatePageCursor | null = null;
    while (remaining.size > 0) {
      const page = await session.listEntryStates({
        sinceCursor: 0, targetCursor, after, limit: RECOVERY_BATCH_SIZE, entryIds: batch,
      });
      if (page.targetCursor < startingCursor) {
        throw new SyncRealtimeError(
          "cursor_ahead_of_server",
          "Recovery snapshot is behind this device's sync history.",
        );
      }
      if (targetCursor !== null && page.targetCursor !== targetCursor) {
        throw new Error("Entry-state pagination changed its target cursor.");
      }
      targetCursor = page.targetCursor;
      const next = page.nextAfter;
      if (page.hasMore && (!next || (after && (
        next.updatedSeq < after.updatedSeq ||
        (next.updatedSeq === after.updatedSeq && next.entryId <= after.entryId)
      )))) {
        throw new Error("Entry-state pagination did not advance.");
      }
      // Legacy servers ignore entryIds. Only decrypt and apply requested states.
      const entries = page.entries.filter((entry) => remaining.delete(entry.entryId));
      const items = await deps.applier.createManifestItems(entries);
      for (const item of items) {
        manifest.set(item.state.entryId, item);
      }
      batchItems.push(...items);
      await deps.onItems(items);
      if (!page.hasMore) break;
      after = next;
    }

    for (const item of batchItems) {
      if (item.state.deleted || deps.shouldApplyRemotePath?.(item.metadata.path, false) === false) {
        continue;
      }
      const existing = await store.getEntryById(item.state.entryId);
      if (existing && item.state.revision < existing.revision) continue;
      const owner = await store.getEntryByPath(item.metadata.path);
      // New local entries have no remote state; the planner handles adoption.
      if (!owner || owner.entryId === item.state.entryId || owner.revision === 0) continue;
      requiredOwners.set(owner.entryId, owner.revision);
      if (!queued.has(owner.entryId)) {
        queued.add(owner.entryId);
        queue.push(owner.entryId);
      }
    }
  }

  for (const [entryId, revision] of requiredOwners) {
    const owner = manifest.get(entryId);
    // Entries updated after the snapshot may be absent from a bounded listing.
    // Retry instead of letting an incomplete manifest supersede a known owner.
    if (!owner || owner.state.revision < revision) {
      throw new Error(`Recovery could not load the current path owner ${entryId}.`);
    }
  }

  const pendingDependencies: string[] = [];
  for (const item of manifest.values()) {
    if (requested.has(item.state.entryId)) continue;
    const remote = await store.getRemoteStateById(item.state.entryId);
    if (remote?.revision !== item.state.revision) continue;
    const pending = await store.getDirtyEntryMutation(item.state.entryId);
    // A dependency can itself need rebasing even if its remote state is known.
    if (pending && pending.baseRevision < item.state.revision) continue;
    const existing = await store.getEntryById(item.state.entryId);
    item.contextOnly = !item.state.deleted && remote.path === item.metadata.path &&
      existing?.path === item.metadata.path;
    if (pending && !item.contextOnly) {
      pendingDependencies.push(item.state.entryId);
    }
  }
  if (pendingDependencies.length > 0) {
    // A rename/restore based on this same revision is newer local work, not a
    // conflict with a new remote edit. Do not replay it or let another plan
    // supersede its local path. Publish it first, then load a fresh snapshot.
    // This guard runs before *any* manifest writes, including supersession.
    throw new RecoveryPendingDependenciesError(pendingDependencies);
  }

  return [...manifest.values()].sort((a, b) =>
    a.state.updatedSeq - b.state.updatedSeq ||
    (a.state.entryId < b.state.entryId ? -1 : a.state.entryId > b.state.entryId ? 1 : 0),
  );
}
