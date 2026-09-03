import path from "node:path";

import { watch, type FSWatcher } from "chokidar";

import { normalizeVaultPath } from "@synch/sync-client/sync/core/file-rules";
import { isNeverSyncReservedPath } from "@synch/sync-client/sync/core/reserved-paths";
import type {
  SyncChangeSource,
  SyncChangeSourceContext,
} from "@synch/sync-client/sync/runtime/change-source";
import { VAULT_TMP_FILE_MARKER, type NodeSyncVaultAdapter } from "./vault-adapter";

const DEFAULT_EVENT_DEBOUNCE_MS = 200;
const DEFAULT_RECONCILE_DEBOUNCE_MS = 2_000;

export interface NodeFsChangeSourceDeps {
  vaultPath: string;
  vaultAdapter: NodeSyncVaultAdapter;
  isSyncableConfigPath?: (vaultRelativePath: string) => boolean;
  /**
   * Requests a full local reconcile for changes the watcher cannot attribute
   * to a single file (e.g. after a watcher error dropped events). Wired by
   * the watch command.
   */
  requestReconcile?: () => void;
  eventDebounceMs?: number;
  reconcileDebounceMs?: number;
  /**
   * Test support: poll instead of native FS events. Native backends (e.g.
   * fsevents on macOS) can permanently drop changes made in a short window
   * after the watcher reports ready, which makes tests nondeterministic.
   * Production callers rely on the startup reconcile to cover that window.
   */
  usePolling?: boolean;
}

export class NodeFsChangeSource implements SyncChangeSource {
  private context: SyncChangeSourceContext | null = null;
  private watcher: FSWatcher | null = null;
  private ready: Promise<void> = Promise.resolve();
  private readonly pendingPaths = new Map<string, ReturnType<typeof setTimeout>>();
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: NodeFsChangeSourceDeps) {}

  start(context: SyncChangeSourceContext): void {
    if (this.watcher) {
      return;
    }

    this.context = context;
    const watcher = watch(this.deps.vaultPath, {
      ignoreInitial: true,
      followSymlinks: false,
      ignored: (watchedPath) => this.isIgnoredAbsolutePath(watchedPath),
      ...(this.deps.usePolling ? { usePolling: true, interval: 25 } : {}),
    });
    watcher.on("add", (eventPath) => this.handlePathEvent(eventPath));
    watcher.on("change", (eventPath) => this.handlePathEvent(eventPath));
    watcher.on("unlink", (eventPath) => this.handlePathEvent(eventPath));
    watcher.on("error", (error) => {
      context.onError(error);
      // Events may have been dropped; fall back to a full reconcile.
      this.scheduleReconcile();
    });
    this.ready = new Promise((resolve) => watcher.once("ready", resolve));
    this.watcher = watcher;
  }

  /** Resolves once the watcher finished its initial scan (used by tests). */
  async whenReady(): Promise<void> {
    await this.ready;
  }

  stop(): void {
    void this.watcher?.close();
    this.watcher = null;
    for (const timer of this.pendingPaths.values()) {
      clearTimeout(timer);
    }
    this.pendingPaths.clear();
    if (this.reconcileTimer) {
      clearTimeout(this.reconcileTimer);
      this.reconcileTimer = null;
    }
  }

  private handlePathEvent(absolutePath: string): void {
    const relativePath = this.toVaultRelativePath(absolutePath);
    if (relativePath) {
      this.schedulePath(relativePath);
    }
  }

  private toVaultRelativePath(absolutePath: string): string | null {
    const relative = path.relative(this.deps.vaultPath, absolutePath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      return null;
    }

    return normalizeVaultPath(relative.split(path.sep).join("/"));
  }

  private isIgnoredAbsolutePath(absolutePath: string): boolean {
    const relativePath = this.toVaultRelativePath(absolutePath);
    if (relativePath === null) {
      // Never ignore the vault root itself.
      return false;
    }

    // Skip atomic-write temp files and hard-reserved trees (.synch, .git,
    // .trash, node_modules); the latter also keeps their directories out of
    // the watcher entirely, which conserves inotify watches on Linux.
    return (
      relativePath.includes(VAULT_TMP_FILE_MARKER) ||
      isNeverSyncReservedPath(relativePath)
    );
  }

  private schedulePath(relativePath: string): void {
    const existing = this.pendingPaths.get(relativePath);
    if (existing) {
      clearTimeout(existing);
    }

    this.pendingPaths.set(
      relativePath,
      setTimeout(() => {
        this.pendingPaths.delete(relativePath);
        this.dispatchPath(relativePath);
      }, this.deps.eventDebounceMs ?? DEFAULT_EVENT_DEBOUNCE_MS),
    );
  }

  private dispatchPath(relativePath: string): void {
    const context = this.context;
    if (!context || !context.hasActiveRemoteVaultSession()) {
      return;
    }

    void context.runLocalMutationWork(async () => {
      try {
        await this.processPath(context, relativePath);
      } catch (error) {
        try {
          context.onFileError?.({
            operation: "modify",
            path: relativePath,
            error,
          });
          context.onError(error);
        } catch {
          // Keep later watch events flowing even if the error reporter fails.
        }
      }
    });
  }

  private async processPath(
    context: SyncChangeSourceContext,
    relativePath: string,
  ): Promise<void> {
    const syncable =
      this.deps.vaultAdapter.isSyncablePath(relativePath) ||
      (this.deps.isSyncableConfigPath?.(relativePath) ?? false);
    const stat = await this.deps.vaultAdapter.statFile(relativePath);

    if (stat) {
      if (!syncable) {
        return;
      }

      // TODO: Route this read through recordUpsertFromFile with stat.size so
      // watcher-triggered CLI reads participate in the shared byte budget.
      // Reading first can exceed the budget when this overlaps push or
      // reconciliation work.
      const bytes = await this.deps.vaultAdapter.readBytes(relativePath);
      const changed = await context.eventRecorder.recordUpsert(
        relativePath,
        bytes,
        stat,
      );
      if (changed) {
        context.onFileQueued?.({ operation: "modify", path: relativePath });
        context.notifyLocalChange();
      }
      return;
    }

    if (await this.deps.vaultAdapter.exists(relativePath)) {
      // The path is a directory now; chokidar attributes contained files
      // individually, so nothing to record for the directory itself.
      return;
    }

    if (!syncable) {
      return;
    }

    const changed = await context.eventRecorder.recordDelete(relativePath);
    if (changed) {
      context.onFileQueued?.({ operation: "delete", path: relativePath });
      context.notifyLocalChange();
    }
  }

  private scheduleReconcile(): void {
    if (!this.deps.requestReconcile || this.reconcileTimer) {
      return;
    }

    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      this.deps.requestReconcile?.();
    }, this.deps.reconcileDebounceMs ?? DEFAULT_RECONCILE_DEBOUNCE_MS);
  }
}
