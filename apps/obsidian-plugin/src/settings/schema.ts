import { getDefaultApiBaseUrl, normalizeApiBaseUrl } from "../config";
import {
  DEFAULT_SYNC_FILE_RULES,
  normalizeSyncFileRules,
  type SyncFileRules,
} from "../sync/core/file-rules";
import {
  DEFAULT_VAULT_CONFIG_SYNC_RULES,
  normalizeVaultConfigSyncRules,
  type VaultConfigSyncRules,
} from "../sync/core/vault-config-rules";

export const SYNCH_SETTINGS_KEY = "settings";

export interface SynchPluginSettings {
  apiBaseUrl: string;
  fileRules: SyncFileRules;
  vaultConfigSync: VaultConfigSyncRules;
  syncEnabled: boolean;
}

export const DEFAULT_SYNCH_PLUGIN_SETTINGS: SynchPluginSettings = {
  apiBaseUrl: getDefaultApiBaseUrl(),
  fileRules: DEFAULT_SYNC_FILE_RULES,
  vaultConfigSync: DEFAULT_VAULT_CONFIG_SYNC_RULES,
  syncEnabled: true,
};

export function normalizeSynchPluginSettings(
  value: unknown,
  defaultApiBaseUrl = getDefaultApiBaseUrl(),
): SynchPluginSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      apiBaseUrl: defaultApiBaseUrl,
      fileRules: DEFAULT_SYNC_FILE_RULES,
      vaultConfigSync: DEFAULT_VAULT_CONFIG_SYNC_RULES,
      syncEnabled: true,
    };
  }

  const record = value as Record<string, unknown>;
  return {
    apiBaseUrl: normalizeApiBaseUrl(record.apiBaseUrl, defaultApiBaseUrl),
    fileRules: normalizeSyncFileRules(record.fileRules),
    vaultConfigSync: normalizeVaultConfigSyncRules(record.vaultConfigSync),
    syncEnabled: typeof record.syncEnabled === "boolean" ? record.syncEnabled : true,
  };
}
