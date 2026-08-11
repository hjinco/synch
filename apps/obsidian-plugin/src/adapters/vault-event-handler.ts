import type { Plugin, TFile } from "obsidian";

import type { SyncAutoLoop } from "@synch/sync-client/sync/engine/auto-sync";
import type { SyncEventRecorder } from "@synch/sync-client/sync/engine/event-recorder";
import type { ObsidianSyncVaultAdapter } from "./vault-adapter";

export interface SyncVaultEventHandlerDeps {
  plugin: Plugin;
  vaultAdapter: ObsidianSyncVaultAdapter;
  eventRecorder: Pick<
    SyncEventRecorder,
    "recordUpsert" | "recordRename" | "recordDelete"
  >;
  autoLoop: Pick<SyncAutoLoop, "notifyLocalChange">;
  runLocalMutationWork: <T>(work: () => Promise<T>) => Promise<T>;
  hasActiveRemoteVaultSession: () => boolean;
  onError: (error: unknown) => void;
  onFileQueued?: (event: {
    operation: "create" | "modify" | "rename" | "delete";
    path: string;
    oldPath?: string;
  }) => void;
  onFileError?: (event: {
    operation: "create" | "modify" | "rename" | "delete";
    path: string;
    oldPath?: string;
    error: unknown;
  }) => void;
}

export class SyncVaultEventHandler {
  constructor(private readonly deps: SyncVaultEventHandlerDeps) {}

  register(): void {
    const { plugin } = this.deps;

    plugin.registerEvent(
      plugin.app.vault.on("create", (file) => {
        const syncableFile = this.deps.vaultAdapter.asSyncableFile(file);
        const path = syncableFile?.path;
        if (!syncableFile || !path) {
          return;
        }

        this.run({ operation: "create", path }, async () => {
          await this.recordUpsert("create", path, syncableFile);
        });
      }),
    );

    plugin.registerEvent(
      plugin.app.vault.on("modify", (file) => {
        const syncableFile = this.deps.vaultAdapter.asSyncableFile(file);
        const path = syncableFile?.path;
        if (!syncableFile || !path) {
          return;
        }

        this.run({ operation: "modify", path }, async () => {
          await this.recordUpsert("modify", path, syncableFile);
        });
      }),
    );

    plugin.registerEvent(
      plugin.app.vault.on("rename", (file, oldPath) => {
        const syncableFile = this.deps.vaultAdapter.asSyncableFile(file);
        const nextPath = syncableFile?.path;
        const renamedFromSyncable = this.deps.vaultAdapter.isSyncablePath(oldPath);
        const renamedToSyncable = !!syncableFile && !!nextPath;
        if (!renamedFromSyncable && !renamedToSyncable) {
          return;
        }

        this.run({ operation: "rename", path: nextPath ?? oldPath, oldPath }, async () => {
          if (renamedFromSyncable && renamedToSyncable && syncableFile && nextPath) {
            const changed = await this.deps.eventRecorder.recordRename(
              oldPath,
              nextPath,
              await this.deps.vaultAdapter.readFile(syncableFile),
              syncableFile.stat,
            );
            this.notifyLocalChangeIfNeeded(changed, {
              operation: "rename",
              path: nextPath,
              oldPath,
            });
            return;
          }

          if (renamedFromSyncable) {
            const changed = await this.deps.eventRecorder.recordDelete(oldPath);
            this.notifyLocalChangeIfNeeded(changed, {
              operation: "rename",
              path: oldPath,
              oldPath,
            });
            return;
          }

          if (syncableFile && nextPath) {
            await this.recordUpsert("rename", nextPath, syncableFile, oldPath);
          }
        });
      }),
    );

    plugin.registerEvent(
      plugin.app.vault.on("delete", (file) => {
        const path = file.path;
        const syncable = this.deps.vaultAdapter.isSyncablePath(path);
        if (!syncable) {
          return;
        }

        this.run({ operation: "delete", path }, async () => {
          const changed = await this.deps.eventRecorder.recordDelete(path);
          this.notifyLocalChangeIfNeeded(changed, { operation: "delete", path });
        });
      }),
    );
  }

  private async recordUpsert(
    operation: "create" | "modify" | "rename",
    path: string,
    file: TFile,
    oldPath?: string,
  ): Promise<void> {
    const changed = await this.deps.eventRecorder.recordUpsert(
      path,
      await this.deps.vaultAdapter.readFile(file),
      file.stat,
    );
    this.notifyLocalChangeIfNeeded(changed, { operation, path, oldPath });
  }

  private run(
    event: {
      operation: "create" | "modify" | "rename" | "delete";
      path: string;
      oldPath?: string;
    },
    work: () => Promise<void>,
  ): void {
    if (!this.deps.hasActiveRemoteVaultSession()) {
      return;
    }

    void this.deps.runLocalMutationWork(async () => {
      try {
        await work();
      } catch (error) {
        try {
          this.deps.onFileError?.({ ...event, error });
          this.deps.onError(error);
        } catch {
          // Keep later vault events flowing even if the error reporter fails.
        }
      }
    });
  }

  private notifyLocalChangeIfNeeded(
    changed: boolean,
    event: {
      operation: "create" | "modify" | "rename" | "delete";
      path: string;
      oldPath?: string;
    },
  ): void {
    if (changed) {
      this.deps.onFileQueued?.(event);
      this.deps.autoLoop.notifyLocalChange();
    }
  }
}
