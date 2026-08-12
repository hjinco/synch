import { describe, expect, it } from "vitest";

import { createTestPlugin } from "../test-support/test-plugin";
import { DEFAULT_VAULT_CONFIG_SYNC_RULES } from "@synch/sync-client/sync/core/vault-config-rules";
import { ObsidianVaultConfigSource } from "./vault-config-source";

describe("ObsidianVaultConfigSource", () => {
  it("lists allowlisted config files through the adapter", async () => {
    const plugin = createTestPlugin();
    const configDir = plugin.app.vault.configDir;
    await plugin.app.vault.adapter.mkdir(configDir);
    await plugin.app.vault.adapter.mkdir(`${configDir}/plugins`);
    await plugin.app.vault.adapter.mkdir(`${configDir}/plugins/calendar`);
    await plugin.app.vault.adapter.write(`${configDir}/app.json`, "{}");
    await plugin.app.vault.adapter.write(`${configDir}/workspace.json`, "{}");
    await plugin.app.vault.adapter.write(
      `${configDir}/plugins/calendar/manifest.json`,
      "{}",
    );
    await plugin.app.vault.adapter.write(
      `${configDir}/plugins/calendar/data.json`,
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
        expect.objectContaining({ path: `${configDir}/app.json` }),
        expect.objectContaining({
          path: `${configDir}/plugins/calendar/manifest.json`,
        }),
      ]),
    );
    expect((await source.listFiles()).map((file) => file.path).sort()).toEqual([
      `${configDir}/app.json`,
      `${configDir}/plugins/calendar/manifest.json`,
    ]);
  });
});
