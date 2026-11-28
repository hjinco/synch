import type { ContentReservation } from "../core/content-runtime";
import type { PullEntryStateApplierDeps, PullEntryStateStore } from "./pull-entry-state-applier";
import { SyncEventRecorder } from "./event-recorder";
import { type PlannedEntryState, uniqueSyncPaths } from "./pull-entry-state-internal";
import { SyncStateChangedError } from "./sync-state-coordinator";

/** Filesystem writers do not acquire sync state keys. Detect changes between
 * preparation and apply, including edits whose watcher event is still queued. */
export class PullLocalFileSnapshots {
  constructor(private readonly deps: Pick<PullEntryStateApplierDeps,
    "vaultAdapter" | "contentRuntime" | "getRemoteVaultKey" | "shouldUseLatestRemoteVersion" | "onLocalMutationQueued">) {}

  async capture(
    paths: ReadonlyArray<string | null | undefined>,
    reservation: ContentReservation,
  ): Promise<Map<string, string | null>> {
    const result = new Map<string, string | null>();
    for (const path of uniqueSyncPaths(paths)) {
      if (!(await this.deps.vaultAdapter.exists(path))) {
        result.set(path, null);
        continue;
      }
      const { hash } = await this.deps.contentRuntime.readAndHash(
        await this.deps.vaultAdapter.getFileSize(path),
        async () => await this.deps.vaultAdapter.readBytes(path), reservation,
      );
      result.set(path, hash);
    }
    return result;
  }

  async recordUnobservedEdits(
    store: PullEntryStateStore,
    plans: PlannedEntryState[],
    files: ReadonlyMap<string, string | null>,
    reservation: ContentReservation,
  ): Promise<boolean> {
    // Watcher delivery can lag a disk write even before the first snapshot.
    const knownPaths = new Set(plans.flatMap((plan) => [
      plan.existing?.path, plan.adoptedLocalEntry?.entry.path, plan.supersededPathOwner?.path,
    ]));
    const adoptedPaths = new Set(plans.flatMap((plan) =>
      plan.adoptedLocalEntry?.hashMatches ? [plan.finalPath] : []));
    const renamePaths = await this.recognizeRenamePaths(store, plans, files);
    const changed: string[] = [];
    for (const [path, diskHash] of files) {
      if (renamePaths.has(path) || this.deps.shouldUseLatestRemoteVersion?.(path)) continue;
      if (diskHash === null && !knownPaths.has(path)) continue;
      const local = await store.getLocalStateByPath(path);
      if (diskHash === (local?.hash ?? null)) continue;
      // Existing uploads already read the current file during conflict resolution.
      // Matching-content adoption, however, would skip the download entirely.
      if (local && diskHash !== null && !adoptedPaths.has(path)) {
        const pending = await store.getDirtyEntryMutation(local.entryId);
        if (pending?.op === "upsert") continue;
      }
      changed.push(path);
    }
    if (changed.length) {
      await this.recordChanges(store, changed, reservation);
    }
    return changed.length > 0;
  }

  private async recognizeRenamePaths(
    store: PullEntryStateStore,
    plans: PlannedEntryState[],
    files: ReadonlyMap<string, string | null>,
  ): Promise<Set<string>> {
    const paths = new Set<string>();
    for (const { existing, finalPath, hash, pathConflict, vaultMove } of plans) {
      if (!existing?.path || existing.deleted || !finalPath || existing.path === finalPath || pathConflict) continue;
      const targetHash = files.get(finalPath);
      if (!targetHash || await store.getLocalStateByPath(finalPath)) continue;
      const sourceHash = files.get(existing.path);
      if (sourceHash === null && (targetHash === existing.hash || targetHash === hash) &&
          !await store.getDirtyEntryMutation(existing.entryId)) {
        // A successful move can survive a failed content write or DB commit.
        // Its old or incoming bytes at the destination need no local mutation.
        paths.add(existing.path);
        paths.add(finalPath);
      } else if (targetHash === hash || (sourceHash === targetHash && vaultMove?.kind === "alias")) {
        // On a case-insensitive volume both spellings can still read the source.
        // Observe any edits through the tracked name, without inventing a new owner.
        paths.add(finalPath);
      }
    }
    return paths;
  }

  async recordChanges(
    store: PullEntryStateStore,
    paths: string[],
    reservation: ContentReservation,
  ): Promise<void> {
    // Do this after releasing the apply keys. Watcher delivery may lag the
    // filesystem; record the edit before retrying the plan against fresh state.
    const recorder = new SyncEventRecorder({
      getSyncStore: () => store,
      areSameFilePaths: this.deps.vaultAdapter.areSameFilePaths?.bind(this.deps.vaultAdapter),
      requireLocalStateForDelete: true,
      getRemoteVaultKey: this.deps.getRemoteVaultKey,
      contentRuntime: this.deps.contentRuntime,
    });
    for (const path of paths) {
      const changed = await recorder.recordFileDuringPull(path, async () => {
        if (!(await this.deps.vaultAdapter.exists(path))) return null;
        return (await this.deps.contentRuntime.readAndHash(
          await this.deps.vaultAdapter.getFileSize(path),
          () => this.deps.vaultAdapter.readBytes(path), reservation,
        )).hash;
      });
      if (changed) this.deps.onLocalMutationQueued?.();
    }
  }
}

export class PullLocalFilesChangedError extends SyncStateChangedError {
  constructor(readonly paths: string[]) {
    super();
  }
}
