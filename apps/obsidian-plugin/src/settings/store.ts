import type { PluginDataStoreLike } from "../plugin-data";
import { getDefaultApiBaseUrl, parseApiBaseUrlInput } from "../config";
import {
  DEFAULT_SYNCH_PLUGIN_SETTINGS,
  normalizeSynchPluginSettings,
  type SynchPluginSettings,
  SYNCH_SETTINGS_KEY,
} from "./schema";
import { normalizeSyncFileRules, type SyncFileRules } from "../sync/core/file-rules";
import {
  normalizeVaultConfigSyncRules,
  type VaultConfigSyncRules,
} from "../sync/core/vault-config-rules";

export class SynchSettingsStore {
  private settings: SynchPluginSettings = DEFAULT_SYNCH_PLUGIN_SETTINGS;

  constructor(
    private readonly pluginDataStore: PluginDataStoreLike,
    private readonly defaultApiBaseUrl = getDefaultApiBaseUrl(),
  ) {}

  initialize(): SynchPluginSettings {
    try {
      this.settings = normalizeSynchPluginSettings(
        this.pluginDataStore.read(SYNCH_SETTINGS_KEY),
        this.defaultApiBaseUrl,
      );
    } catch (error) {
      this.settings = {
        ...DEFAULT_SYNCH_PLUGIN_SETTINGS,
        apiBaseUrl: this.defaultApiBaseUrl,
      };
      throw error;
    }

    return this.settings;
  }

  getSnapshot(): SynchPluginSettings {
    return this.settings;
  }

  async updateApiBaseUrl(nextValue: string): Promise<boolean> {
    const normalized = parseApiBaseUrlInput(nextValue, this.defaultApiBaseUrl);
    if (normalized === this.settings.apiBaseUrl) {
      return false;
    }

    this.settings = {
      ...this.settings,
      apiBaseUrl: normalized,
    };
    this.pluginDataStore.write(SYNCH_SETTINGS_KEY, this.settings);
    await this.pluginDataStore.save();
    return true;
  }

  async updateFileRules(nextRules: SyncFileRules): Promise<boolean> {
    const normalized = normalizeSyncFileRules(nextRules);
    if (JSON.stringify(normalized) === JSON.stringify(this.settings.fileRules)) {
      return false;
    }

    this.settings = {
      ...this.settings,
      fileRules: normalized,
    };
    this.pluginDataStore.write(SYNCH_SETTINGS_KEY, this.settings);
    await this.pluginDataStore.save();
    return true;
  }

  async updateVaultConfigSyncRules(
    nextRules: VaultConfigSyncRules,
  ): Promise<boolean> {
    const normalized = normalizeVaultConfigSyncRules(nextRules);
    if (
      JSON.stringify(normalized) === JSON.stringify(this.settings.vaultConfigSync)
    ) {
      return false;
    }

    this.settings = {
      ...this.settings,
      vaultConfigSync: normalized,
    };
    this.pluginDataStore.write(SYNCH_SETTINGS_KEY, this.settings);
    await this.pluginDataStore.save();
    return true;
  }

  async updateSyncEnabled(enabled: boolean): Promise<boolean> {
    if (enabled === this.settings.syncEnabled) {
      return false;
    }

    this.settings = {
      ...this.settings,
      syncEnabled: enabled,
    };
    this.pluginDataStore.write(SYNCH_SETTINGS_KEY, this.settings);
    await this.pluginDataStore.save();
    return true;
  }
}
