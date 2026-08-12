import { describe, expect, it } from "vitest";

import type { PluginDataStoreLike } from "../adapters/plugin-data";
import { DEFAULT_SYNC_FILE_RULES } from "@synch/sync-client/sync/core/file-rules";
import { DEFAULT_VAULT_CONFIG_SYNC_RULES } from "@synch/sync-client/sync/core/vault-config-rules";
import type { SynchPluginSettings } from "./schema";
import { SYNCH_SETTINGS_KEY } from "./schema";
import { SynchSettingsStore } from "./store";

describe("SynchSettingsStore", () => {
  it("preserves file rules when updating the API base URL", async () => {
    const pluginDataStore = new MemoryPluginDataStore({
      apiBaseUrl: "https://api.synch.test",
      syncEnabled: false,
      syncIntervalMs: 0,
      fileRules: {
        ...DEFAULT_SYNC_FILE_RULES,
        includeImages: false,
        excludedFolders: ["Archive"],
      },
      vaultConfigSync: DEFAULT_VAULT_CONFIG_SYNC_RULES,
    });
    const store = new SynchSettingsStore(pluginDataStore, "https://default.synch.test");
    store.initialize();

    await store.updateApiBaseUrl(" https://custom.synch.test/// ");

    expect(pluginDataStore.read<SynchPluginSettings>(SYNCH_SETTINGS_KEY)).toEqual({
      apiBaseUrl: "https://custom.synch.test",
      syncEnabled: false,
      fileRules: {
        ...DEFAULT_SYNC_FILE_RULES,
        includeImages: false,
        excludedFolders: ["Archive"],
      },
      vaultConfigSync: DEFAULT_VAULT_CONFIG_SYNC_RULES,
      syncIntervalMs: 0,
    });
  });

  it("preserves the API base URL when updating file rules", async () => {
    const pluginDataStore = new MemoryPluginDataStore({
      apiBaseUrl: "https://custom.synch.test",
      syncEnabled: false,
      fileRules: DEFAULT_SYNC_FILE_RULES,
    });
    const store = new SynchSettingsStore(pluginDataStore, "https://default.synch.test");
    store.initialize();

    await store.updateFileRules({
      ...DEFAULT_SYNC_FILE_RULES,
      includeAudio: false,
    });

    expect(pluginDataStore.read<SynchPluginSettings>(SYNCH_SETTINGS_KEY)).toEqual({
      apiBaseUrl: "https://custom.synch.test",
      syncEnabled: false,
      fileRules: {
        ...DEFAULT_SYNC_FILE_RULES,
        includeAudio: false,
      },
      vaultConfigSync: DEFAULT_VAULT_CONFIG_SYNC_RULES,
      syncIntervalMs: 0,
    });
  });

  it("strips the active config folder from included hidden folders", async () => {
    const pluginDataStore = new MemoryPluginDataStore({
      apiBaseUrl: "https://custom.synch.test",
      syncEnabled: true,
      fileRules: DEFAULT_SYNC_FILE_RULES,
      vaultConfigSync: DEFAULT_VAULT_CONFIG_SYNC_RULES,
    });
    const store = new SynchSettingsStore(pluginDataStore, "https://default.synch.test");
    store.initialize();

    await store.updateFileRules(
      {
        ...DEFAULT_SYNC_FILE_RULES,
        includedHiddenFolders: [".obsidian", ".assets"],
      },
      ".obsidian",
    );

    expect(store.getSnapshot().fileRules.includedHiddenFolders).toEqual([".assets"]);
  });

  it("rejects invalid API base URL updates without saving", async () => {
    const pluginDataStore = new MemoryPluginDataStore({
      apiBaseUrl: "https://api.synch.test",
      syncEnabled: true,
      fileRules: DEFAULT_SYNC_FILE_RULES,
    });
    const store = new SynchSettingsStore(pluginDataStore, "https://default.synch.test");
    store.initialize();

    await expect(store.updateApiBaseUrl("ftp://api.synch.test")).rejects.toThrow();

    expect(pluginDataStore.saveCount).toBe(0);
    expect(store.getSnapshot().apiBaseUrl).toBe("https://api.synch.test");
  });

  it("adds https when updating the API base URL without a protocol", async () => {
    const pluginDataStore = new MemoryPluginDataStore({
      apiBaseUrl: "https://api.synch.test",
      syncEnabled: true,
      fileRules: DEFAULT_SYNC_FILE_RULES,
      vaultConfigSync: DEFAULT_VAULT_CONFIG_SYNC_RULES,
    });
    const store = new SynchSettingsStore(pluginDataStore, "https://default.synch.test");
    store.initialize();

    await store.updateApiBaseUrl("custom.synch.test");

    expect(store.getSnapshot().apiBaseUrl).toBe("https://custom.synch.test");
    expect(pluginDataStore.saveCount).toBe(1);
  });

  it("rejects API base URL updates with query strings or fragments", async () => {
    const pluginDataStore = new MemoryPluginDataStore({
      apiBaseUrl: "https://api.synch.test",
      syncEnabled: true,
      fileRules: DEFAULT_SYNC_FILE_RULES,
    });
    const store = new SynchSettingsStore(pluginDataStore, "https://default.synch.test");
    store.initialize();

    await expect(
      store.updateApiBaseUrl("https://api.synch.test?env=dev"),
    ).rejects.toThrow();
    await expect(
      store.updateApiBaseUrl("https://api.synch.test#dev"),
    ).rejects.toThrow();

    expect(pluginDataStore.saveCount).toBe(0);
    expect(store.getSnapshot().apiBaseUrl).toBe("https://api.synch.test");
  });

  it("preserves other settings when updating sync enabled", async () => {
    const pluginDataStore = new MemoryPluginDataStore({
      apiBaseUrl: "https://custom.synch.test",
      syncEnabled: true,
      fileRules: {
        ...DEFAULT_SYNC_FILE_RULES,
        includeAudio: false,
      },
      vaultConfigSync: DEFAULT_VAULT_CONFIG_SYNC_RULES,
      syncIntervalMs: 0,
    });
    const store = new SynchSettingsStore(pluginDataStore, "https://default.synch.test");
    store.initialize();

    await store.updateSyncEnabled(false);

    expect(pluginDataStore.read<SynchPluginSettings>(SYNCH_SETTINGS_KEY)).toEqual({
      apiBaseUrl: "https://custom.synch.test",
      syncEnabled: false,
      fileRules: {
        ...DEFAULT_SYNC_FILE_RULES,
        includeAudio: false,
      },
      vaultConfigSync: DEFAULT_VAULT_CONFIG_SYNC_RULES,
      syncIntervalMs: 0,
    });
  });

  it("does not save unchanged sync enabled state", async () => {
    const pluginDataStore = new MemoryPluginDataStore({
      apiBaseUrl: "https://custom.synch.test",
      syncEnabled: false,
      fileRules: DEFAULT_SYNC_FILE_RULES,
    });
    const store = new SynchSettingsStore(pluginDataStore, "https://default.synch.test");
    store.initialize();

    await store.updateSyncEnabled(false);

    expect(pluginDataStore.saveCount).toBe(0);
  });

  it("persists supported sync intervals and normalizes unsupported values", async () => {
    const pluginDataStore = new MemoryPluginDataStore({
      apiBaseUrl: "https://custom.synch.test",
      syncEnabled: true,
      syncIntervalMs: 0,
      fileRules: DEFAULT_SYNC_FILE_RULES,
      vaultConfigSync: DEFAULT_VAULT_CONFIG_SYNC_RULES,
    });
    const store = new SynchSettingsStore(pluginDataStore, "https://default.synch.test");
    store.initialize();

    await store.updateSyncIntervalMs(180_000);
    expect(store.getSnapshot().syncIntervalMs).toBe(180_000);

    await store.updateSyncIntervalMs(42_000);
    expect(store.getSnapshot().syncIntervalMs).toBe(0);
    expect(pluginDataStore.saveCount).toBe(2);
  });
});

class MemoryPluginDataStore implements PluginDataStoreLike {
  saveCount = 0;
  private readonly data: Record<string, unknown>;

  constructor(settings: Partial<SynchPluginSettings>) {
    this.data = {
      [SYNCH_SETTINGS_KEY]: settings,
    };
  }

  async initialize(): Promise<void> {}

  read<T = unknown>(key: string): T | undefined {
    return this.data[key] as T | undefined;
  }

  write(key: string, value: unknown): void {
    this.data[key] = value;
  }

  async save(): Promise<void> {
    this.saveCount += 1;
  }
}
