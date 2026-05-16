import { describe, expect, it } from "vitest";

import { DEFAULT_SYNC_FILE_RULES } from "../sync/core/file-rules";
import { DEFAULT_VAULT_CONFIG_SYNC_RULES } from "../sync/core/vault-config-rules";
import { normalizeSynchPluginSettings } from "./schema";

describe("normalizeSynchPluginSettings", () => {
  const defaultApiBaseUrl = "https://api.synch.test";

  it("defaults the API base URL when existing settings do not include it", () => {
    const settings = normalizeSynchPluginSettings(
      {
        fileRules: DEFAULT_SYNC_FILE_RULES,
      },
      defaultApiBaseUrl,
    );

    expect(settings.apiBaseUrl).toBe(defaultApiBaseUrl);
    expect(settings.syncEnabled).toBe(true);
    expect(settings.vaultConfigSync).toEqual(DEFAULT_VAULT_CONFIG_SYNC_RULES);
  });

  it("trims whitespace and trailing slashes from the API base URL", () => {
    expect(
      normalizeSynchPluginSettings(
        {
          apiBaseUrl: " https://api.synch.test/// ",
          fileRules: DEFAULT_SYNC_FILE_RULES,
        },
        defaultApiBaseUrl,
      ).apiBaseUrl,
    ).toBe("https://api.synch.test");
  });

  it("defaults invalid and non-http API base URLs", () => {
    expect(
      normalizeSynchPluginSettings(
        {
          apiBaseUrl: "not-a-url",
          fileRules: DEFAULT_SYNC_FILE_RULES,
        },
        defaultApiBaseUrl,
      ).apiBaseUrl,
    ).toBe(defaultApiBaseUrl);

    expect(
      normalizeSynchPluginSettings(
        {
          apiBaseUrl: "ftp://api.synch.test",
          fileRules: DEFAULT_SYNC_FILE_RULES,
        },
        defaultApiBaseUrl,
      ).apiBaseUrl,
    ).toBe(defaultApiBaseUrl);
  });

  it("defaults API base URLs with query strings or fragments", () => {
    expect(
      normalizeSynchPluginSettings(
        {
          apiBaseUrl: "https://api.synch.test?env=dev",
          fileRules: DEFAULT_SYNC_FILE_RULES,
        },
        defaultApiBaseUrl,
      ).apiBaseUrl,
    ).toBe(defaultApiBaseUrl);

    expect(
      normalizeSynchPluginSettings(
        {
          apiBaseUrl: "https://api.synch.test#dev",
          fileRules: DEFAULT_SYNC_FILE_RULES,
        },
        defaultApiBaseUrl,
      ).apiBaseUrl,
    ).toBe(defaultApiBaseUrl);
  });

  it("normalizes the persisted sync enabled flag", () => {
    expect(
      normalizeSynchPluginSettings(
        {
          apiBaseUrl: defaultApiBaseUrl,
          fileRules: DEFAULT_SYNC_FILE_RULES,
          syncEnabled: false,
        },
        defaultApiBaseUrl,
      ).syncEnabled,
    ).toBe(false);

    expect(
      normalizeSynchPluginSettings(
        {
          apiBaseUrl: defaultApiBaseUrl,
          fileRules: DEFAULT_SYNC_FILE_RULES,
          syncEnabled: "false",
        },
        defaultApiBaseUrl,
      ).syncEnabled,
    ).toBe(true);
  });

  it("normalizes vault configuration sync settings", () => {
    expect(
      normalizeSynchPluginSettings(
        {
          apiBaseUrl: defaultApiBaseUrl,
          fileRules: DEFAULT_SYNC_FILE_RULES,
          vaultConfigSync: {
            enabled: true,
            configDir: ".obsidian-mobile",
            communityPluginFiles: true,
          },
        },
        defaultApiBaseUrl,
      ).vaultConfigSync,
    ).toEqual({
      ...DEFAULT_VAULT_CONFIG_SYNC_RULES,
      enabled: true,
      configDir: ".obsidian-mobile",
      communityPluginFiles: true,
    });
  });
});
