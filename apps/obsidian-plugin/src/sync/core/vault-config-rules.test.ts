import { describe, expect, it } from "vitest";

import {
  DEFAULT_VAULT_CONFIG_SYNC_RULES,
  normalizeVaultConfigSyncRules,
  shouldSyncVaultConfigPath,
} from "./vault-config-rules";

describe("shouldSyncVaultConfigPath", () => {
  it("excludes all config paths when disabled", () => {
    expect(
      shouldSyncVaultConfigPath(
        ".obsidian/app.json",
        DEFAULT_VAULT_CONFIG_SYNC_RULES,
      ),
    ).toBe(false);
  });

  it("allows selected Obsidian configuration categories", () => {
    const rules = {
      ...DEFAULT_VAULT_CONFIG_SYNC_RULES,
      enabled: true,
      communityPluginList: true,
      communityPluginFiles: true,
      communityPluginData: true,
    };

    expect(shouldSyncVaultConfigPath(".obsidian/app.json", rules)).toBe(true);
    expect(shouldSyncVaultConfigPath(".obsidian/appearance.json", rules)).toBe(true);
    expect(shouldSyncVaultConfigPath(".obsidian/hotkeys.json", rules)).toBe(true);
    expect(shouldSyncVaultConfigPath(".obsidian/core-plugins.json", rules)).toBe(true);
    expect(shouldSyncVaultConfigPath(".obsidian/graph.json", rules)).toBe(true);
    expect(shouldSyncVaultConfigPath(".obsidian/snippets/tweaks.css", rules)).toBe(true);
    expect(shouldSyncVaultConfigPath(".obsidian/themes/theme.json", rules)).toBe(true);
    expect(
      shouldSyncVaultConfigPath(
        ".obsidian/plugins/calendar/manifest.json",
        rules,
      ),
    ).toBe(true);
    expect(
      shouldSyncVaultConfigPath(".obsidian/plugins/calendar/data.json", rules),
    ).toBe(true);
  });

  it("keeps device-local and Synch-owned config files excluded", () => {
    const rules = {
      ...DEFAULT_VAULT_CONFIG_SYNC_RULES,
      enabled: true,
      communityPluginFiles: true,
      communityPluginData: true,
    };

    expect(shouldSyncVaultConfigPath(".obsidian/workspace.json", rules)).toBe(false);
    expect(shouldSyncVaultConfigPath(".obsidian/workspace-mobile.json", rules)).toBe(false);
    expect(
      shouldSyncVaultConfigPath(".obsidian/plugins/synch/manifest.json", rules),
    ).toBe(false);
    expect(
      shouldSyncVaultConfigPath(".obsidian/plugins/synch/main.js", rules),
    ).toBe(false);
    expect(
      shouldSyncVaultConfigPath(".obsidian/plugins/synch/styles.css", rules),
    ).toBe(false);
    expect(
      shouldSyncVaultConfigPath(".obsidian/plugins/synch/data.json", rules),
    ).toBe(false);
  });

  it("supports override config folders", () => {
    const rules = normalizeVaultConfigSyncRules({
      ...DEFAULT_VAULT_CONFIG_SYNC_RULES,
      enabled: true,
      configDir: ".obsidian-mobile",
    });

    expect(shouldSyncVaultConfigPath(".obsidian-mobile/app.json", rules)).toBe(true);
    expect(shouldSyncVaultConfigPath(".obsidian/app.json", rules)).toBe(false);
  });
});
