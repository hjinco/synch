import { App, Plugin, Setting } from "obsidian";
import { vi } from "vitest";

import { getStorageDisplayState as resolveStorageDisplayState } from "../../../adapters/storage-warning";
import type { SynchDeletedFile } from "../../contracts";
import { DEFAULT_SYNC_FILE_RULES } from "@synch/sync-client/sync/core/file-rules";
import { DEFAULT_VAULT_CONFIG_SYNC_RULES } from "@synch/sync-client/sync/core/vault-config-rules";
import type { SynchSettingsController } from "../controller";
import { SynchSettingTab } from "../settings-tab";

const TestPlugin = Plugin as unknown as new () => Plugin;

interface DefinitionRecord {
  type?: string;
  name?: string;
  desc?: string;
  heading?: string;
  visible?: boolean | (() => boolean);
  items?: unknown[];
  render?: (setting: unknown, group: unknown) => unknown;
  control?: {
    type: string;
    key: string;
    options?: Record<string, string>;
  };
}

/**
 * Test stand-in for Obsidian's declarative settings renderer (>= 1.13, the
 * plugin's minAppVersion): walks getSettingDefinitions() and materializes
 * each user-visible row with the obsidian test stubs — group headings become
 * heading rows, `render` callbacks populate the provided row, and `control`
 * definitions bind to get/setControlValue. update() re-renders, mirroring
 * the framework's refresh behavior for an open settings tab.
 */
export class DeclarativeTestSettingTab extends SynchSettingTab {
  open(): void {
    this.renderItems(this.getSettingDefinitions());
  }

  update(): void {
    this.open();
  }

  private renderItems(items: unknown[]): void {
    for (const item of items) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const record = item as DefinitionRecord;
      if (isHidden(record.visible)) {
        continue;
      }
      if (record.type === "group" || record.type === "list") {
        if (record.heading) {
          createRowSetting().setName(record.heading).setHeading();
        }
        this.renderItems(record.items ?? []);
        continue;
      }
      if (!(record.name || record.render || record.control)) {
        continue;
      }

      const setting = createRowSetting();
      setting.setName(record.name ?? "");
      if (record.desc !== undefined) {
        setting.setDesc(record.desc);
      }
      if (record.render) {
        record.render(setting, {});
        continue;
      }
      if (record.control) {
        this.bindControl(setting, record.control);
      }
    }
  }

  private bindControl(
    setting: Setting,
    control: NonNullable<DefinitionRecord["control"]>,
  ): void {
    const value = this.getControlValue(control.key);
    if (control.type === "toggle") {
      setting.addToggle((toggle) =>
        toggle.setValue(value === true).onChange(async (next) => {
          await this.setControlValue(control.key, next);
        }),
      );
      return;
    }
    if (control.type === "dropdown") {
      setting.addDropdown((dropdown) => {
        for (const [optionValue, label] of Object.entries(control.options ?? {})) {
          dropdown.addOption(optionValue, label);
        }
        dropdown.setValue(String(value)).onChange(async (next) => {
          await this.setControlValue(control.key, next);
        });
      });
    }
  }
}

function isHidden(visible: boolean | (() => boolean) | undefined): boolean {
  return (typeof visible === "function" ? visible() : visible) === false;
}

// The obsidian test stub ignores the container element.
function createRowSetting(): Setting {
  return new Setting(null as unknown as HTMLElement);
}

export function createSettingsTab(
  overrides: Partial<SynchSettingsController> = {},
): DeclarativeTestSettingTab {
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
    getStorageDisplayState: () =>
      resolveStorageDisplayState(
        (overrides.getStorageStatus ?? (() => null))(),
        false,
      ),
    watchStorageStatus: vi.fn(),
    unwatchStorageStatus: vi.fn(),
    getRemoteVaultStatusLabel: () => "No vault connected.",
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

  return new DeclarativeTestSettingTab(new App(), new TestPlugin(), controller);
}

export async function nextTask(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
