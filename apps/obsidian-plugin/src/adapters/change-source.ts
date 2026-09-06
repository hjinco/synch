import type { Plugin } from "obsidian";

import type {
  SyncChangeSource,
  SyncChangeSourceContext,
} from "@synch/sync-client/engine";
import type { ObsidianSyncVaultAdapter } from "./vault-adapter";
import { SyncVaultEventHandler } from "./vault-event-handler";

export interface ObsidianSyncChangeSourceDeps {
  plugin: Plugin;
  vaultAdapter: ObsidianSyncVaultAdapter;
}

export class ObsidianSyncChangeSource implements SyncChangeSource {
  constructor(private readonly deps: ObsidianSyncChangeSourceDeps) {}

  start(context: SyncChangeSourceContext): void {
    new SyncVaultEventHandler({
      plugin: this.deps.plugin,
      vaultAdapter: this.deps.vaultAdapter,
      eventRecorder: context.eventRecorder,
      autoLoop: {
        notifyLocalChange: () => context.notifyLocalChange(),
      },
      runLocalMutationWork: async (work) => await context.runLocalMutationWork(work),
      hasActiveRemoteVaultSession: () => context.hasActiveRemoteVaultSession(),
      onError: (error) => context.onError(error),
      onFileQueued: context.onFileQueued,
      onFileError: context.onFileError,
    }).register();
  }
}
