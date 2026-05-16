import { describe, expect, it } from "vitest";

import { DEFAULT_SYNC_FILE_RULES } from "../core/file-rules";
import { DEFAULT_VAULT_CONFIG_SYNC_RULES } from "../core/vault-config-rules";
import { createTestPlugin } from "../../test-support/test-plugin";
import { ObsidianSyncVaultAdapter } from "./obsidian-vault-adapter";

describe("ObsidianSyncVaultAdapter", () => {
  it("lists files from included hidden folders through the adapter", async () => {
    const plugin = createTestPlugin();
    await plugin.app.vault.adapter.mkdir(".assets");
    await plugin.app.vault.adapter.mkdir(".assets/nested");
    await plugin.app.vault.adapter.writeBinary(
      ".assets/nested/file.md",
      new TextEncoder().encode("hidden").buffer,
    );
    await plugin.app.vault.adapter.mkdir(".git");
    await plugin.app.vault.adapter.writeBinary(
      ".git/config",
      new TextEncoder().encode("ignored").buffer,
    );
    const adapter = new ObsidianSyncVaultAdapter(
      plugin,
      () => ({
        ...DEFAULT_SYNC_FILE_RULES,
        includedHiddenFolders: [".assets", ".git"],
      }),
      () => DEFAULT_VAULT_CONFIG_SYNC_RULES,
    );

    const files = await adapter.listFiles();

    expect(files.map((file) => file.path)).toEqual([".assets/nested/file.md"]);
    await expect(files[0]?.readBytes()).resolves.toEqual(
      new TextEncoder().encode("hidden"),
    );
  });
});
