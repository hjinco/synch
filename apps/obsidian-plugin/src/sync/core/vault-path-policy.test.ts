import { describe, expect, it } from "vitest";

import { DEFAULT_SYNC_FILE_RULES } from "./file-rules";
import { DEFAULT_VAULT_CONFIG_SYNC_RULES } from "./vault-config-rules";
import {
  decideVaultPathSync,
  isForbiddenVaultPath,
  shouldApplyRemoteVaultPath,
  shouldUseLatestRemoteVaultConfig,
} from "./vault-path-policy";

const DEFAULT_CONFIG_DIR = ".obsidian";

describe("decideVaultPathSync", () => {
  it("syncs normal vault files selected by file rules", () => {
    expect(
      decideVaultPathSync("Notes/daily.md", {
        fileRules: DEFAULT_SYNC_FILE_RULES,
        vaultConfigRules: DEFAULT_VAULT_CONFIG_SYNC_RULES,
        configDir: DEFAULT_CONFIG_DIR,
      }).kind,
    ).toBe("sync");
  });

  it("syncs selected vault config files without treating disabled hidden paths as forbidden", () => {
    const vaultConfigRules = {
      ...DEFAULT_VAULT_CONFIG_SYNC_RULES,
      enabled: true,
    };

    expect(
      decideVaultPathSync(".obsidian/app.json", {
        fileRules: DEFAULT_SYNC_FILE_RULES,
        vaultConfigRules,
        configDir: DEFAULT_CONFIG_DIR,
      }).kind,
    ).toBe("sync");
    expect(
      decideVaultPathSync(".assets/file.md", {
        fileRules: DEFAULT_SYNC_FILE_RULES,
        vaultConfigRules,
        configDir: DEFAULT_CONFIG_DIR,
      }).kind,
    ).toBe("ignore-local");
  });

  it("does not let file rules bypass custom vault config rules", () => {
    const vaultConfigRules = {
      ...DEFAULT_VAULT_CONFIG_SYNC_RULES,
      enabled: false,
    };
    const configDir = ".obsidian-mobile";

    expect(
      decideVaultPathSync(".obsidian-mobile/app.json", {
        fileRules: {
          ...DEFAULT_SYNC_FILE_RULES,
          includedHiddenFolders: [".obsidian-mobile"],
        },
        vaultConfigRules,
        configDir,
      }).kind,
    ).toBe("ignore-local");
    expect(
      decideVaultPathSync(".obsidian/app.json", {
        fileRules: DEFAULT_SYNC_FILE_RULES,
        vaultConfigRules,
        configDir,
      }).kind,
    ).toBe("ignore-local");
  });

  it("marks never-sync and device-local config paths as forbidden", () => {
    expect(isForbiddenVaultPath(".git/config", DEFAULT_CONFIG_DIR)).toBe(true);
    expect(
      isForbiddenVaultPath(".obsidian/workspace.json", DEFAULT_CONFIG_DIR),
    ).toBe(true);
    expect(
      isForbiddenVaultPath(".obsidian/plugins/synch/data.json", DEFAULT_CONFIG_DIR),
    ).toBe(true);
    expect(isForbiddenVaultPath(".obsidian/app.json", DEFAULT_CONFIG_DIR)).toBe(
      false,
    );
  });

  it("treats inactive Obsidian config folders as unmanaged hidden paths", () => {
    const vaultConfigRules = {
      ...DEFAULT_VAULT_CONFIG_SYNC_RULES,
      enabled: true,
    };
    const configDir = ".obsidian-mobile";

    expect(isForbiddenVaultPath(".obsidian/app.json", configDir)).toBe(false);
    expect(isForbiddenVaultPath(".obsidian/workspace.json", configDir)).toBe(false);
    expect(isForbiddenVaultPath(".obsidian-mobile/app.json", configDir)).toBe(false);
    expect(
      decideVaultPathSync(".obsidian/app.json", {
        fileRules: DEFAULT_SYNC_FILE_RULES,
        vaultConfigRules,
        configDir,
      }).kind,
    ).toBe("ignore-local");
    expect(
      decideVaultPathSync(".obsidian/app.json", {
        fileRules: {
          ...DEFAULT_SYNC_FILE_RULES,
          includeOtherFiles: true,
          includedHiddenFolders: [".obsidian"],
        },
        vaultConfigRules,
        configDir,
      }).kind,
    ).toBe("sync");
    expect(
      decideVaultPathSync(".obsidian/app.json", {
        fileRules: {
          ...DEFAULT_SYNC_FILE_RULES,
          includeOtherFiles: true,
          includedHiddenFolders: [".obsidian"],
        },
        vaultConfigRules: DEFAULT_VAULT_CONFIG_SYNC_RULES,
        configDir: DEFAULT_CONFIG_DIR,
      }).kind,
    ).toBe("ignore-local");
  });
});

describe("shouldApplyRemoteVaultPath", () => {
  it("keeps normal remote files eligible while honoring vault config rules", () => {
    expect(
      shouldApplyRemoteVaultPath("Notes/daily.md", {
        fileRules: DEFAULT_SYNC_FILE_RULES,
        vaultConfigRules: DEFAULT_VAULT_CONFIG_SYNC_RULES,
        configDir: DEFAULT_CONFIG_DIR,
      }),
    ).toBe(true);
    expect(
      shouldApplyRemoteVaultPath(".obsidian/app.json", {
        fileRules: DEFAULT_SYNC_FILE_RULES,
        vaultConfigRules: DEFAULT_VAULT_CONFIG_SYNC_RULES,
        configDir: DEFAULT_CONFIG_DIR,
      }),
    ).toBe(false);
    expect(
      shouldApplyRemoteVaultPath(".obsidian/app.json", {
        fileRules: DEFAULT_SYNC_FILE_RULES,
        vaultConfigRules: {
          ...DEFAULT_VAULT_CONFIG_SYNC_RULES,
          enabled: true,
        },
        configDir: DEFAULT_CONFIG_DIR,
      }),
    ).toBe(true);
  });

  it("does not apply inactive Obsidian config paths as generic remote files", () => {
    const vaultConfigRules = {
      ...DEFAULT_VAULT_CONFIG_SYNC_RULES,
      enabled: true,
    };
    const configDir = ".obsidian-mobile";

    expect(
      shouldApplyRemoteVaultPath(".obsidian/app.json", {
        fileRules: DEFAULT_SYNC_FILE_RULES,
        vaultConfigRules,
        configDir,
      }),
    ).toBe(false);
    expect(
      shouldApplyRemoteVaultPath(".obsidian-mobile/app.json", {
        fileRules: DEFAULT_SYNC_FILE_RULES,
        vaultConfigRules,
        configDir,
      }),
    ).toBe(true);
  });

  it("applies explicitly included hidden folders from remote", () => {
    expect(
      shouldApplyRemoteVaultPath(".assets/image.png", {
        fileRules: {
          ...DEFAULT_SYNC_FILE_RULES,
          includedHiddenFolders: [".assets"],
        },
        vaultConfigRules: DEFAULT_VAULT_CONFIG_SYNC_RULES,
        configDir: DEFAULT_CONFIG_DIR,
      }),
    ).toBe(true);
    expect(
      shouldApplyRemoteVaultPath(".assets/image.png", {
        fileRules: DEFAULT_SYNC_FILE_RULES,
        vaultConfigRules: DEFAULT_VAULT_CONFIG_SYNC_RULES,
        configDir: DEFAULT_CONFIG_DIR,
      }),
    ).toBe(false);
  });
});

describe("shouldUseLatestRemoteVaultConfig", () => {
  const vaultConfigRules = {
    ...DEFAULT_VAULT_CONFIG_SYNC_RULES,
    enabled: true,
  };

  it("uses latest-remote conflict handling only for enabled vault config paths", () => {
    expect(
      shouldUseLatestRemoteVaultConfig(".obsidian/graph.json", {
        vaultConfigRules,
        configDir: DEFAULT_CONFIG_DIR,
      }),
    ).toBe(true);
    expect(
      shouldUseLatestRemoteVaultConfig("Notes/daily.md", {
        vaultConfigRules,
        configDir: DEFAULT_CONFIG_DIR,
      }),
    ).toBe(false);
    expect(
      shouldUseLatestRemoteVaultConfig(".obsidian/workspace.json", {
        vaultConfigRules,
        configDir: DEFAULT_CONFIG_DIR,
      }),
    ).toBe(false);
  });
});
