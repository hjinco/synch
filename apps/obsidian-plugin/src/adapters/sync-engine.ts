import type { Plugin } from "obsidian";

import { defaultHttpClient } from "./http";
import {
  SyncEngine,
  type SyncEngineDeps,
} from "@synch/sync-client/sync/runtime/sync-engine";
import { ObsidianSyncVaultAdapter } from "./vault-adapter";
import { ObsidianVaultConfigSource } from "./vault-config-source";
import { ObsidianSyncChangeSource } from "./change-source";

export type ObsidianSyncEngineDeps = Omit<
  SyncEngineDeps,
  | "vaultAdapter"
  | "vaultConfigSource"
  | "httpClient"
  | "changeSource"
  | "getConfigDir"
  | "createWebSocket"
> & {
  plugin: Plugin;
};

export function createObsidianSyncEngine(
  deps: ObsidianSyncEngineDeps,
): SyncEngine {
  const vaultAdapter = new ObsidianSyncVaultAdapter(
    deps.plugin,
    () => deps.getSyncFileRules(),
  );
  const vaultConfigSource = new ObsidianVaultConfigSource(
    deps.plugin,
    () => deps.getVaultConfigSyncRules(),
  );

  return new SyncEngine({
    ...deps,
    vaultAdapter,
    vaultConfigSource,
    httpClient: defaultHttpClient,
    getConfigDir: () => deps.plugin.app.vault.configDir,
    createWebSocket: (url, protocols) => new WebSocket(url, protocols),
    changeSource: new ObsidianSyncChangeSource({
      plugin: deps.plugin,
      vaultAdapter,
    }),
  });
}
