import { getDefaultApiBaseUrl, normalizeApiBaseUrl } from "../config";
import {
  DEFAULT_SYNC_FILE_RULES,
  normalizeSyncFileRules,
  type SyncFileRules,
  DEFAULT_VAULT_CONFIG_SYNC_RULES,
  normalizeVaultConfigSyncRules,
  type VaultConfigSyncRules,
} from "@synch/sync-client/core";

export const SYNCH_SETTINGS_KEY = "settings";
export const REALTIME_SYNC_INTERVAL_MS = 0;
export const SYNC_INTERVAL_OPTIONS_MS = [
  REALTIME_SYNC_INTERVAL_MS,
  30_000,
  60_000,
  3 * 60_000,
  5 * 60_000,
  10 * 60_000,
  15 * 60_000,
  20 * 60_000,
  30 * 60_000,
] as const;

export interface SynchPluginSettings {
  apiBaseUrl: string;
  fileRules: SyncFileRules;
  vaultConfigSync: VaultConfigSyncRules;
  syncEnabled: boolean;
  syncIntervalMs: number;
}

export const DEFAULT_SYNCH_PLUGIN_SETTINGS: SynchPluginSettings = {
  apiBaseUrl: getDefaultApiBaseUrl(),
  fileRules: DEFAULT_SYNC_FILE_RULES,
  vaultConfigSync: DEFAULT_VAULT_CONFIG_SYNC_RULES,
  syncEnabled: true,
  syncIntervalMs: REALTIME_SYNC_INTERVAL_MS,
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
      syncIntervalMs: REALTIME_SYNC_INTERVAL_MS,
    };
  }

  const record = value as Record<string, unknown>;
  return {
    apiBaseUrl: normalizeApiBaseUrl(record.apiBaseUrl, defaultApiBaseUrl),
    fileRules: normalizeSyncFileRules(record.fileRules),
    vaultConfigSync: normalizeVaultConfigSyncRules(record.vaultConfigSync),
    syncEnabled: typeof record.syncEnabled === "boolean" ? record.syncEnabled : true,
    syncIntervalMs: normalizeSyncIntervalMs(record.syncIntervalMs),
  };
}

export function normalizeSyncIntervalMs(value: unknown): number {
  return typeof value === "number" &&
    SYNC_INTERVAL_OPTIONS_MS.includes(value)
    ? value
    : REALTIME_SYNC_INTERVAL_MS;
}
