import { App, Plugin } from "obsidian";
import { vi } from "vitest";

import type { SynchDeletedFile } from "../../plugin/view-models";
import { DEFAULT_SYNC_FILE_RULES } from "@synch/sync-client/sync/core/file-rules";
import { DEFAULT_VAULT_CONFIG_SYNC_RULES } from "@synch/sync-client/sync/core/vault-config-rules";
import type { SynchSettingsController } from "../controller";
import { SynchSettingTab } from "../settings-tab";

const TestPlugin = Plugin as unknown as new () => Plugin;

export function createSettingsTab(
  overrides: Partial<SynchSettingsController> = {},
): SynchSettingTab {
  const controller: SynchSettingsController = {
    getAuthReadiness: () => ({ state: "anonymous" }),
    getAuthStatusLabel: () => "Not signed in.",
    getSyncState: () => "not_ready",
    getSyncStatusLabel: () => "Sync: not ready 0%",
    getSyncPercent: () => 0,
    getSyncProgress: () => ({
      completedEntries: 0,
      totalEntries: 0,
    }),
    getSyncLogs: () => ({
      count: 0,
      text: "Synch sync diagnostics",
    }),
    clearSyncLogs: vi.fn(() => {}),
    subscribeSyncLogs: () => () => {},
    listFileSizeBlockedFiles: vi.fn(async () => []),
    isSyncEnabled: () => true,
    setSyncEnabled: vi.fn(async () => {}),
    getSyncIntervalMs: () => 0,
    setSyncIntervalMs: vi.fn(async () => {}),
    syncNow: vi.fn(async () => {}),
    getCommunityPluginUpdateStatus: () => ({
      state: "up_to_date",
      currentVersion: "0.0.1",
      latestVersion: "0.0.1",
    }),
    ensureCommunityPluginUpdateCheck: vi.fn(async () => {}),
    retryCommunityPluginUpdateCheck: vi.fn(async () => {}),
    getServerCompatibilityStatus: () => ({ state: "idle" }),
    getSubscriptionStatus: () => ({ state: "idle" }),
    ensureSubscriptionStatusCheck: vi.fn(async () => {}),
    retrySubscriptionStatusCheck: vi.fn(async () => {}),
    openBillingManagementPage: vi.fn(() => {}),
    openPricingPage: vi.fn(() => {}),
    getStorageStatus: () => null,
    watchStorageStatus: vi.fn(),
    unwatchStorageStatus: vi.fn(),
    getRemoteVaultStatusLabel: () => "No vault connected.",
    getRemoteVaultSyncFormatVersion: () => null,
    getApiBaseUrl: () => "http://127.0.0.1:8787",
    hasAuthenticatedSession: () => false,
    isDeviceLoginInProgress: () => false,
    hasConnectedRemoteVault: () => false,
    beginDeviceLogin: vi.fn(async () => {}),
    cancelDeviceLogin: vi.fn(() => {}),
    signOutDevice: vi.fn(async () => {}),
    createRemoteVaultFromPrompt: vi.fn(async () => {}),
    connectRemoteVaultFromPrompt: vi.fn(async () => {}),
    openRemoteVaultManagementPage: vi.fn(() => {}),
    disconnectRemoteVault: vi.fn(async () => {}),
    updateApiBaseUrl: vi.fn(async () => {}),
    getSyncFileRules: () => ({
      ...DEFAULT_SYNC_FILE_RULES,
      excludedFolders: [...DEFAULT_SYNC_FILE_RULES.excludedFolders],
    }),
    getVaultConfigSyncRules: () => DEFAULT_VAULT_CONFIG_SYNC_RULES,
    updateSyncFileRule: vi.fn(async () => {}),
    updateVaultConfigSyncRule: vi.fn(async () => {}),
    updateExcludedFolders: vi.fn(async () => {}),
    listSelectableExcludedFolderPaths: () => [],
    updateIncludedHiddenFolders: vi.fn(async () => {}),
    listSelectableIncludedHiddenFolderPaths: vi.fn(async () => []),
    listDeletedFiles: vi.fn(async () => ({
      files: [],
      hasMore: false,
      nextBefore: null,
    })),
    previewDeletedFile: vi.fn(async () => ({
      status: "unavailable" as const,
      path: "deleted.md",
      reason: null,
      capturedAt: null,
      message: "This version has no previewable content.",
    })),
    restoreDeletedFiles: vi.fn(async (files: SynchDeletedFile[]) => ({
      restored: files.length,
      failures: [],
    })),
    purgeDeletedFiles: vi.fn(async (files: SynchDeletedFile[]) => ({
      purged: files.length,
      failures: [],
    })),
    ...overrides,
  };

  return new SynchSettingTab(new App(), new TestPlugin(), controller);
}

export async function nextTask(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
