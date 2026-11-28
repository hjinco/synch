import type { DeferredSyncFile } from "../store/store";
import type { PullEntryStateManifestItem, PullRollbackEvent } from "./pull-entry-state-internal";
import type { PullEntryStateWindowApplyResult } from "./pull-entry-state-applier";
import { validateManifestItem } from "./pull-manifest-planner";
import type { SyncPullStore } from "./pull-service";

export class DeviceFileRulesChangedError extends Error {
  constructor() {
    super("Device file rules changed during sync.");
    this.name = "DeviceFileRulesChangedError";
  }
}

/** A selection snapshot for one pull. The persisted cursor can advance past
 * excluded files without advancing the base revision of their local copies. */
export class DeviceFileSelection {
  private readonly known = new Map<string, DeferredSyncFile | undefined>();

  readonly newlyIncluded = new Set<string>();

  private constructor(
    private readonly store: SyncPullStore,
    private readonly excludes: ((path: string) => boolean) | undefined,
    private readonly onRollback: ((event: PullRollbackEvent) => void) | undefined,
    private readonly allMarkersLoaded: boolean,
    files: DeferredSyncFile[],
  ) {
    for (const file of files) {
      this.known.set(file.entryId, file);
      if (!this.excludes?.(file.path)) this.newlyIncluded.add(file.entryId);
    }
  }

  static async load(
    store: SyncPullStore,
    excludes?: (path: string) => boolean,
    onRollback?: (event: PullRollbackEvent) => void,
    scanForInclusions = true,
  ): Promise<DeviceFileSelection> {
    const files = scanForInclusions ? await store.deferredFiles?.list() ?? [] : [];
    return new DeviceFileSelection(store, excludes, onRollback, scanForInclusions, files);
  }

  hasDeferred(entryId: string): boolean {
    return !!this.known.get(entryId);
  }

  async hasMovedFrom(entryId: string, path: string): Promise<boolean> {
    // A destination can belong to an entry outside the incoming manifest.
    if (!this.allMarkersLoaded && !this.known.has(entryId)) {
      this.known.set(entryId, await this.store.deferredFiles?.get(entryId));
    }
    const deferred = this.known.get(entryId);
    return !!deferred && deferred.path !== path && !!this.excludes?.(deferred.path);
  }

  async applyWindow(
    manifest: PullEntryStateManifestItem[],
    apply: (items: PullEntryStateManifestItem[]) => Promise<PullEntryStateWindowApplyResult>,
  ): Promise<PullEntryStateWindowApplyResult> {
    const fileStore = this.store.deferredFiles;
    if (!fileStore || !this.excludes) return apply(manifest);

    if (!this.allMarkersLoaded) {
      const ids = manifest.map(({ state }) => state.entryId).filter((id) => !this.known.has(id));
      if (ids.length) {
        const files = await fileStore.getMany(ids);
        ids.forEach((id, index) => this.known.set(id, files[index]));
      }
    }

    const allowed: PullEntryStateManifestItem[] = [];
    const skipped: DeferredSyncFile[] = [];
    const completed = [];
    const finished: string[] = [];
    for (const item of manifest) {
      const { state, metadata } = item;
      const excluded = this.excludes(metadata.path);
      const known = this.known.get(state.entryId);
      const applied = excluded || known ? await this.store.getRemoteStateById(state.entryId) : null;
      const revision = Math.max(known?.revision ?? 0, applied?.revision ?? 0);
      if (state.revision < revision) {
        this.onRollback?.({
          entryId: state.entryId, path: metadata.path, localRevision: revision, remoteRevision: state.revision,
        });
        continue;
      }
      // A crash can leave a marker after the vault write and entry commit.
      // Replaying that revision could consume a subsequent local edit.
      if (known && applied && applied.revision === state.revision) {
        finished.push(state.entryId);
        completed.push(state);
        continue;
      }
      if (excluded) {
        validateManifestItem(item);
        completed.push(state);
        if (!applied || state.revision > applied.revision) {
          skipped.push({ entryId: state.entryId, path: metadata.path, revision: state.revision });
        }
      } else {
        allowed.push(item);
      }
    }

    if (skipped.length) {
      await fileStore.put(skipped);
      for (const file of skipped) {
        this.known.set(file.entryId, file);
        this.newlyIncluded.delete(file.entryId);
      }
    }
    const result = await apply(allowed);
    for (const state of result.completedStates) {
      if (this.hasDeferred(state.entryId)) finished.push(state.entryId);
    }
    if (finished.length) {
      await fileStore.remove(finished);
      for (const id of finished) {
        this.known.delete(id);
        this.newlyIncluded.delete(id);
      }
    }
    result.completedStates.push(...completed.map(({ entryId, revision }) => ({ entryId, revision })));
    return result;
  }
}
