import { describe, expect, it } from "vitest";

import {
  DEFAULT_VAULT_CONFIG_SYNC_RULES,
  shouldSyncVaultConfigPath,
} from "./vault-config-rules";

const DEFAULT_CONFIG_DIR = ".obsidian";

describe("shouldSyncVaultConfigPath", () => {
  it("excludes all config paths when disabled", () => {
    expect(
      shouldSyncVaultConfigPath(
        ".obsidian/app.json",
        DEFAULT_VAULT_CONFIG_SYNC_RULES,
        DEFAULT_CONFIG_DIR,
      ),
    ).toBe(false);
  });

  it("allows selected Obsidian configuration categories", () => {
    const syncRules = {
      ...DEFAULT_VAULT_CONFIG_SYNC_RULES,
      enabled: true,
      communityPluginList: true,
      communityPluginFiles: true,
      communityPluginData: true,
    };

    expect(
      shouldSyncVaultConfigPath(".obsidian/app.json", syncRules, DEFAULT_CONFIG_DIR),
    ).toBe(true);
    expect(
      shouldSyncVaultConfigPath(
        ".obsidian/appearance.json",
        syncRules,
        DEFAULT_CONFIG_DIR,
      ),
    ).toBe(true);
    expect(
      shouldSyncVaultConfigPath(".obsidian/hotkeys.json", syncRules, DEFAULT_CONFIG_DIR),
    ).toBe(true);
    expect(
      shouldSyncVaultConfigPath(
        ".obsidian/core-plugins.json",
        syncRules,
        DEFAULT_CONFIG_DIR,
      ),
    ).toBe(true);
    expect(
      shouldSyncVaultConfigPath(".obsidian/graph.json", syncRules, DEFAULT_CONFIG_DIR),
    ).toBe(true);
    expect(
      shouldSyncVaultConfigPath(
        ".obsidian/snippets/tweaks.css",
        syncRules,
        DEFAULT_CONFIG_DIR,
      ),
    ).toBe(true);
    expect(
      shouldSyncVaultConfigPath(
        ".obsidian/themes/theme.json",
        syncRules,
        DEFAULT_CONFIG_DIR,
      ),
    ).toBe(true);
    expect(
      shouldSyncVaultConfigPath(
        ".obsidian/plugins/calendar/manifest.json",
        syncRules,
        DEFAULT_CONFIG_DIR,
      ),
    ).toBe(true);
    expect(
      shouldSyncVaultConfigPath(
        ".obsidian/plugins/calendar/data.json",
        syncRules,
        DEFAULT_CONFIG_DIR,
      ),
    ).toBe(true);
  });

  it("keeps device-local and Synch-owned config files excluded", () => {
    const syncRules = {
      ...DEFAULT_VAULT_CONFIG_SYNC_RULES,
      enabled: true,
      communityPluginFiles: true,
      communityPluginData: true,
    };

    expect(
      shouldSyncVaultConfigPath(
        ".obsidian/workspace.json",
        syncRules,
        DEFAULT_CONFIG_DIR,
      ),
    ).toBe(false);
    expect(
      shouldSyncVaultConfigPath(
        ".obsidian/workspace-mobile.json",
        syncRules,
        DEFAULT_CONFIG_DIR,
      ),
    ).toBe(false);
    expect(
      shouldSyncVaultConfigPath(
        ".obsidian/plugins/synch/manifest.json",
        syncRules,
        DEFAULT_CONFIG_DIR,
      ),
    ).toBe(false);
    expect(
      shouldSyncVaultConfigPath(
        ".obsidian/plugins/synch/main.js",
        syncRules,
        DEFAULT_CONFIG_DIR,
      ),
    ).toBe(false);
    expect(
      shouldSyncVaultConfigPath(
        ".obsidian/plugins/synch/styles.css",
        syncRules,
        DEFAULT_CONFIG_DIR,
      ),
    ).toBe(false);
    expect(
      shouldSyncVaultConfigPath(
        ".obsidian/plugins/synch/data.json",
        syncRules,
        DEFAULT_CONFIG_DIR,
      ),
    ).toBe(false);
  });

  it("uses the provided Vault#configDir", () => {
    const syncRules = {
      ...DEFAULT_VAULT_CONFIG_SYNC_RULES,
      enabled: true,
    };

    expect(
      shouldSyncVaultConfigPath(
        ".obsidian-mobile/app.json",
        syncRules,
        ".obsidian-mobile",
      ),
    ).toBe(true);
    expect(
      shouldSyncVaultConfigPath(".obsidian/app.json", syncRules, ".obsidian-mobile"),
    ).toBe(false);
  });
});
