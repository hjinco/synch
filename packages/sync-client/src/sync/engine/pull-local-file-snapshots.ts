import type { ContentReservation } from "../core/content-runtime";
import type { PullEntryStateApplierDeps, PullEntryStateStore } from "./pull-entry-state-applier";
import { SyncEventRecorder } from "./event-recorder";
import { uniqueSyncPaths } from "./pull-entry-state-internal";
import { SyncStateChangedError } from "./sync-state-coordinator";

/** Filesystem writers do not acquire sync state keys. Detect changes between
 * preparation and apply, including edits whose watcher event is still queued. */
export class PullLocalFileSnapshots {
  constructor(private readonly deps: Pick<PullEntryStateApplierDeps,
    "vaultAdapter" | "contentRuntime" | "getRemoteVaultKey">) {}

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

  async recordChanges(
    store: PullEntryStateStore,
    paths: string[],
    reservation: ContentReservation,
  ): Promise<void> {
    // Do this after releasing the apply keys. Watcher delivery may lag the
    // filesystem; record the edit before retrying the plan against fresh state.
    const recorder = new SyncEventRecorder({
      getSyncStore: () => store,
      getRemoteVaultKey: this.deps.getRemoteVaultKey,
      contentRuntime: this.deps.contentRuntime,
    });
    for (const path of paths) {
      if (!(await this.deps.vaultAdapter.exists(path))) {
        await recorder.recordDelete(path);
        continue;
      }
      await this.deps.contentRuntime.withReadBytes(
        await this.deps.vaultAdapter.getFileSize(path),
        async () => await this.deps.vaultAdapter.readBytes(path),
        async (bytes) => await recorder.recordUpsert(path, bytes), reservation,
      );
    }
  }
}

export class PullLocalFilesChangedError extends SyncStateChangedError {
  constructor(readonly paths: string[]) {
    super();
  }
}
