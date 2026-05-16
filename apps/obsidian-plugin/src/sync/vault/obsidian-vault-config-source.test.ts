import { describe, expect, it } from "vitest";

import { createTestPlugin } from "../../test-support/test-plugin";
import { DEFAULT_VAULT_CONFIG_SYNC_RULES } from "../core/vault-config-rules";
import { ObsidianVaultConfigSource } from "./obsidian-vault-config-source";

describe("ObsidianVaultConfigSource", () => {
  it("lists allowlisted config files through the adapter", async () => {
    const plugin = createTestPlugin();
    await plugin.app.vault.adapter.mkdir(".obsidian");
    await plugin.app.vault.adapter.mkdir(".obsidian/plugins");
    await plugin.app.vault.adapter.mkdir(".obsidian/plugins/calendar");
    await plugin.app.vault.adapter.write(".obsidian/app.json", "{}");
    await plugin.app.vault.adapter.write(".obsidian/workspace.json", "{}");
    await plugin.app.vault.adapter.write(
      ".obsidian/plugins/calendar/manifest.json",
      "{}",
    );
    await plugin.app.vault.adapter.write(
      ".obsidian/plugins/calendar/data.json",
      "{}",
    );

    const source = new ObsidianVaultConfigSource(plugin, () => ({
      ...DEFAULT_VAULT_CONFIG_SYNC_RULES,
      enabled: true,
      communityPluginFiles: true,
      communityPluginData: false,
    }));

    await expect(source.listFiles()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ".obsidian/app.json" }),
        expect.objectContaining({
          path: ".obsidian/plugins/calendar/manifest.json",
        }),
      ]),
    );
    expect((await source.listFiles()).map((file) => file.path).sort()).toEqual([
      ".obsidian/app.json",
      ".obsidian/plugins/calendar/manifest.json",
    ]);
  });
});
