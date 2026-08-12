import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getButtonComponents,
  getCreatedElements,
  getDropdownComponents,
  getExtraButtonComponents,
  getNotices,
  getProgressBarComponents,
  getSettingClasses,
  getSettingDescriptions,
  getSettingNames,
  getTextComponents,
  resetObsidianMocks,
} from "../../test-stubs/obsidian";
import { t } from "../../i18n";
import { createSettingsTab, nextTask } from "./__tests__/settings-tab-helpers";
import type { SynchSettingsController } from "./controller";
import type { SynchSyncState } from "../contracts";

describe("SynchSettingTab sync status", () => {
  beforeEach(() => {
    resetObsidianMocks();
  });

  it("does not show a sync progress bar after sign-in", () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
      getSyncStatusLabel: () => "Sync: not ready 0%",
      getSyncPercent: () => 0,
      getSyncProgress: () => ({
        completedEntries: 0,
        totalEntries: 0,
      }),
    });

    tab.display();

    expect(getProgressBarComponents().map(({ value }) => value)).toEqual([0]);
  });

  it("prompts users to create or connect a remote vault before showing sync progress", () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => false,
      getSyncState: () => "syncing",
      getSyncStatusLabel: () => "Sync: syncing 37%",
      getSyncPercent: () => 37,
      getSyncProgress: () => ({
        completedEntries: 42,
        totalEntries: 113,
      }),
      getStorageStatus: () => ({
        storageUsedBytes: 24_300_000,
        storageLimitBytes: 50_000_000,
      }),
    });

    tab.display();

    expect(getSettingNames()).toContain(t("sync.label"));
    expect(getSettingNames()).not.toContain(t("vault.setting"));
    expect(getSettingNames()).not.toContain(t("storage.label"));
    expect(getSettingDescriptions()[0]).toBe(t("sync.connectRemoteVault"));
    expect(getButtonComponents().map((button) => button.text)).toContain(t("vault.create"));
    expect(getButtonComponents().map((button) => button.text)).toContain(t("vault.connect"));
    expect(getProgressBarComponents()).toEqual([]);
    expect(getExtraButtonComponents()).toEqual([]);
  });

  it("refreshes settings after creating a vault from the sync section", async () => {
    let hasConnectedRemoteVault = false;
    const createRemoteVaultFromPrompt = vi.fn(async () => {
      hasConnectedRemoteVault = true;
    });
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => hasConnectedRemoteVault,
      createRemoteVaultFromPrompt,
    });

    tab.display();

    await getButtonComponents()
      .find((button) => button.text === t("vault.create"))
      ?.click();

    expect(createRemoteVaultFromPrompt).toHaveBeenCalledTimes(1);
    expect(getSettingNames()).toContain(t("vault.setting"));
    expect(getButtonComponents().map((button) => button.text)).toContain(
      t("vault.disconnect"),
    );
  });

  it("refreshes settings after connecting a vault from the sync section", async () => {
    let hasConnectedRemoteVault = false;
    const connectRemoteVaultFromPrompt = vi.fn(async () => {
      hasConnectedRemoteVault = true;
    });
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => hasConnectedRemoteVault,
      connectRemoteVaultFromPrompt,
    });

    tab.display();

    await getButtonComponents()
      .find((button) => button.text === t("vault.connect"))
      ?.click();

    expect(connectRemoteVaultFromPrompt).toHaveBeenCalledTimes(1);
    expect(getSettingNames()).toContain(t("vault.setting"));
    expect(getButtonComponents().map((button) => button.text)).toContain(
      t("vault.disconnect"),
    );
  });

  it("places authentication below sync after sign-in", () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      isDeviceLoginInProgress: () => false,
    });

    tab.display();

    expect(getSettingNames().slice(0, 5)).toEqual([
      "Synch",
      t("sync.label"),
      t("authentication"),
      t("subscription.label"),
      t("vault.manage"),
    ]);
  });

  it("shows sync progress when entries are syncing", () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
      getSyncState: () => "syncing",
      getSyncStatusLabel: () => "Sync: syncing 37%",
      getSyncPercent: () => 37,
      getSyncProgress: () => ({
        completedEntries: 42,
        totalEntries: 113,
      }),
    });

    tab.display();

    expect(getSettingDescriptions()[0]).toBe(
      `${t("sync.state.syncing")} 37% - 42 / 113`,
    );
    expect(getProgressBarComponents().map(({ value }) => value)).toEqual([0]);
    expect(getSyncSpinnerElements()).toEqual([
      expect.objectContaining({
        attributes: expect.objectContaining({
          "aria-hidden": "true",
          "data-icon": "loader-circle",
        }),
      }),
    ]);
  });

  it("shows a spinner while sync is reconnecting", () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
      getSyncState: () => "reconnecting",
      getSyncStatusLabel: () => "Sync: reconnecting 0%",
    });

    tab.display();

    expect(getSyncSpinnerElements()).toHaveLength(1);
    expect(getSyncSpinnerElements()[0]?.attributes["data-icon"]).toBe("loader-circle");
  });

  it("refreshes sync progress without rerendering the settings tab", () => {
    let syncState: SynchSyncState = "syncing";
    let completedEntries = 42;
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
      getSyncState: () => syncState,
      getSyncStatusLabel: () => `Sync: syncing ${completedEntries}%`,
      getSyncProgress: () => ({
        completedEntries,
        totalEntries: 100,
      }),
    });

    tab.display();

    const settingNamesAfterDisplay = getSettingNames();
    expect(getSyncSpinnerElements()).toHaveLength(1);

    completedEntries = 57;
    tab.handleUiEvent({ type: "sync-status-changed" });

    expect(getSettingNames()).toEqual(settingNamesAfterDisplay);
    expect(getSyncSpinnerElements()).toHaveLength(1);

    syncState = "up_to_date";
    tab.handleUiEvent({ type: "sync-status-changed" });

    expect(getSettingNames()).toEqual(settingNamesAfterDisplay);
    expect(getSyncSpinnerElements()).toHaveLength(0);
  });

  it("refreshes storage status without rerendering the settings tab", () => {
    let storageStatus: ReturnType<SynchSettingsController["getStorageStatus"]> = {
      storageUsedBytes: 10,
      storageLimitBytes: 100,
    };
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
      getStorageStatus: () => storageStatus,
    });

    tab.display();

    const settingNamesAfterDisplay = getSettingNames();
    expect(getProgressBarComponents()).toHaveLength(1);
    expect(getProgressBarComponents()[0]?.value).toBe(10);

    storageStatus = {
      storageUsedBytes: 95,
      storageLimitBytes: 100,
    };
    tab.handleUiEvent({ type: "storage-status-changed" });

    expect(getSettingNames()).toEqual(settingNamesAfterDisplay);
    expect(getProgressBarComponents()).toHaveLength(1);
    expect(getProgressBarComponents()[0]?.value).toBe(95);
    expect(getSettingClasses()[2]).toContain("synch-storage-warning");
  });

  it("shows a stop button while sync is enabled", async () => {
    const setSyncEnabled = vi.fn(async () => {});
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
      getSyncState: () => "syncing",
      getSyncStatusLabel: () => "Sync: syncing 37%",
      setSyncEnabled,
    });

    tab.display();

    expect(getButtonComponents()[0]?.text).toBe(t("sync.stop"));
    await getButtonComponents()[0]?.click();
    expect(setSyncEnabled).toHaveBeenCalledWith(false);
    expect(getExtraButtonComponents()).toEqual([]);
  });

  it("shows sync diagnostics after the sync frequency section", async () => {
    const setSyncIntervalMs = vi.fn(async () => {});
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
      getSyncIntervalMs: () => 180_000,
      setSyncIntervalMs,
    });

    tab.display();

    expect(getSettingNames().at(-2)).toBe(t("sync.frequency"));
    expect(getSettingNames().at(-1)).toBe(t("diagnostics.header"));
    const dropdown = getDropdownComponents()[0];
    expect(dropdown?.value).toBe("180000");
    expect([...dropdown?.options.entries() ?? []]).toContainEqual([
      "0",
      t("sync.frequencyRealtime"),
    ]);
    await dropdown?.change("300000");
    expect(setSyncIntervalMs).toHaveBeenCalledWith(300_000);
  });

  it("opens, copies, and clears the current sync diagnostics from the final setting", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    let logText = "Synch sync diagnostics\nentry";
    let logCount = 1;
    let notifyLogChanged: (() => void) | null = null;
    const clearSyncLogs = vi.fn(() => {
      logCount = 0;
      logText = "Synch sync diagnostics";
      notifyLogChanged?.();
    });
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
      getSyncLogs: () => ({
        count: logCount,
        text: logText,
      }),
      clearSyncLogs,
      subscribeSyncLogs: (listener) => {
        notifyLogChanged = listener;
        return () => {};
      },
    });

    tab.display();

    const openButton = getButtonComponents().find(
      (button) => button.text === t("diagnostics.open"),
    );
    await openButton?.click();

    expect(getCreatedElements().map((element) => element.text)).not.toContain(
      "Warning: Logs include file names and vault-relative folder paths. Review them before sharing. File contents, keys, and tokens are not included.",
    );
    logText = "Synch sync diagnostics\nentry\nfile_sync_completed";
    notifyLogChanged?.();
    expect(getTextComponents().at(-1)?.inputEl.value).toBe(logText);
    const copyButton = getButtonComponents().find(
      (button) => button.text === t("diagnostics.copy"),
    );
    await copyButton?.click();

    expect(writeText).toHaveBeenCalledWith(logText);
    expect(getNotices()).toContainEqual({
      message: t("diagnostics.copied"),
      timeout: undefined,
    });

    const clearButton = getButtonComponents().find(
      (button) => button.text === t("diagnostics.clear"),
    );
    await clearButton?.click();
    expect(clearSyncLogs).toHaveBeenCalledTimes(1);
    expect(getCreatedElements().map((element) => element.text)).toContain(
      t("diagnostics.empty"),
    );
    expect(getNotices()).toContainEqual({
      message: t("diagnostics.cleared"),
      timeout: undefined,
    });
    vi.unstubAllGlobals();
  });

  it("runs a manual sync from the sync status row", async () => {
    const syncNow = vi.fn(async () => {});
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
      getSyncIntervalMs: () => 180_000,
      syncNow,
    });

    tab.display();

    await getButtonComponents().find((button) => button.text === t("sync.now"))?.click();
    expect(syncNow).toHaveBeenCalledTimes(1);
  });

  it("hides manual sync while realtime sync is selected", () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
      getSyncIntervalMs: () => 0,
    });

    tab.display();

    expect(
      getButtonComponents().some((button) => button.text === t("sync.now")),
    ).toBe(false);
  });

  it("shows a file size warning tooltip when files are blocked by sync limits", async () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
      getSyncState: () => "up_to_date",
      getSyncStatusLabel: () => "Sync: up to date 99%",
      getSyncProgress: () => ({
        completedEntries: 4000,
        totalEntries: 4001,
      }),
      listFileSizeBlockedFiles: vi.fn(async () => [
        {
          path: "large.bin",
          encryptedSizeBytes: 12_400_000,
          maxFileSizeBytes: 10_000_000,
        },
        {
          path: "larger.bin",
          encryptedSizeBytes: 22_400_000,
          maxFileSizeBytes: 10_000_000,
        },
      ]),
    });

    tab.display();
    await nextTask();

    expect(getSettingDescriptions()[0]).toBe(
      `${t("sync.state.up_to_date")} 99% - 4000 / 4001`,
    );
    expect(getFileSizeWarningElements()).toEqual([
      expect.objectContaining({
        attributes: expect.objectContaining({
          "aria-hidden": "true",
          "data-icon": "triangle-alert",
          "data-tooltip": t("sync.fileSizeBlocked", { count: 2 }),
          "data-tooltip-delay": "1",
          "data-tooltip-placement": "right",
        }),
      }),
    ]);
  });

  it("refreshes the file size warning without rerendering the settings tab", async () => {
    let blockedFiles: Awaited<ReturnType<SynchSettingsController["listFileSizeBlockedFiles"]>> = [];
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
      getSyncState: () => "up_to_date",
      getSyncStatusLabel: () => "Sync: up to date 99%",
      listFileSizeBlockedFiles: vi.fn(async () => blockedFiles),
    });

    tab.display();
    await nextTask();

    expect(getFileSizeWarningElements()).toEqual([]);
    const settingNamesAfterDisplay = getSettingNames();
    const settingDescriptionsAfterDisplay = getSettingDescriptions();

    blockedFiles = [
      {
        path: "large.bin",
        encryptedSizeBytes: 12_400_000,
        maxFileSizeBytes: 10_000_000,
      },
    ];
    tab.refreshFileSizeBlockedWarning();
    await nextTask();

    expect(getSettingNames()).toEqual(settingNamesAfterDisplay);
    expect(getFileSizeWarningElements()).toEqual([
      expect.objectContaining({
        attributes: expect.objectContaining({
          "data-tooltip": t("sync.fileSizeBlocked", { count: 1 }),
        }),
      }),
    ]);
    tab.handleUiEvent({ type: "sync-status-changed" });

    expect(getSettingNames()).toEqual(settingNamesAfterDisplay);
    expect(getSettingDescriptions()).toEqual(settingDescriptionsAfterDisplay);
    expect(getFileSizeWarningElements()).toHaveLength(1);

    blockedFiles = [];
    tab.refreshFileSizeBlockedWarning();
    await nextTask();

    expect(getSettingNames()).toEqual(settingNamesAfterDisplay);
    expect(getFileSizeWarningElements()).toEqual([]);
  });

  it("shows a start button while sync is disabled", async () => {
    const setSyncEnabled = vi.fn(async () => {});
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
      getSyncState: () => "paused",
      getSyncStatusLabel: () => "Sync: paused 37%",
      getSyncProgress: () => ({
        completedEntries: 12,
        totalEntries: 12,
      }),
      isSyncEnabled: () => false,
      setSyncEnabled,
    });

    tab.display();

    expect(getButtonComponents()[0]?.text).toBe(t("sync.start"));
    expect(getSettingDescriptions()[0]).toBe(
      `${t("sync.state.paused")} - 12 / 12`,
    );
    await getButtonComponents()[0]?.click();
    expect(setSyncEnabled).toHaveBeenCalledWith(true);
    expect(getExtraButtonComponents()).toEqual([]);
  });

  it("does not show a spinner while sync is offline", () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
      getSyncState: () => "offline",
      getSyncStatusLabel: () => "Sync: offline 0%",
    });

    tab.display();

    expect(getSyncSpinnerElements()).toEqual([]);
    expect(getExtraButtonComponents()).toEqual([]);
  });

  it("shows remote storage usage below the sync status when available", () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
      getSyncStatusLabel: () => "Sync: synced 100%",
      getSyncPercent: () => 100,
      getSyncProgress: () => ({
        completedEntries: 12,
        totalEntries: 12,
      }),
      getStorageStatus: () => ({
        storageUsedBytes: 24_300_000,
        storageLimitBytes: 50_000_000,
      }),
    });

    tab.display();

    expect(getSettingNames().slice(1, 3)).toEqual([t("sync.label"), t("storage.label")]);
    expect(getSettingDescriptions()[0]).toBe(
      "synced 100% - 12 / 12",
    );
    expect(getSettingDescriptions()[1]).toBe("24.3 MB / 50 MB (49%)");
    expect(getProgressBarComponents().map(({ value }) => value)).toEqual([
      49,
    ]);
    expect(getSettingClasses()[2]).not.toContain("synch-storage-warning");
  });

  it("does not warn below the remote storage warning threshold", () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
      getSyncStatusLabel: () => "Sync: synced 100%",
      getSyncProgress: () => ({
        completedEntries: 12,
        totalEntries: 12,
      }),
      getStorageStatus: () => ({
        storageUsedBytes: 94,
        storageLimitBytes: 100,
      }),
    });

    tab.display();

    expect(getSettingDescriptions()[1]).toBe("94 B / 100 B (94%)");
    expect(getProgressBarComponents()[0]?.value).toBe(94);
    expect(getSettingClasses()[2]).not.toContain("synch-storage-warning");
  });

  it("warns when remote storage is at least 95 percent full", () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
      getSyncStatusLabel: () => "Sync: synced 100%",
      getSyncProgress: () => ({
        completedEntries: 12,
        totalEntries: 12,
      }),
      getStorageStatus: () => ({
        storageUsedBytes: 95,
        storageLimitBytes: 100,
      }),
    });

    tab.display();

    const warningDescription = getSettingDescriptions()[1];
    expect(warningDescription).toBe(
      t("storage.warning", { usage: "95 B / 100 B (95%)" }),
    );
    expect(warningDescription).toContain("95 B / 100 B (95%)");
    expect(getProgressBarComponents()[0]?.value).toBe(95);
    expect(getSettingClasses()[2]).toContain("synch-storage-warning");
  });

  it("shows a full warning when remote storage reaches the limit", () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
      getSyncStatusLabel: () => "Sync: synced 100%",
      getSyncProgress: () => ({
        completedEntries: 12,
        totalEntries: 12,
      }),
      getStorageStatus: () => ({
        storageUsedBytes: 101,
        storageLimitBytes: 100,
      }),
    });

    tab.display();

    const fullDescription = getSettingDescriptions()[1];
    expect(fullDescription).toBe(
      t("storage.full", { usage: "101 B / 100 B (101%)" }),
    );
    expect(fullDescription).toContain("101 B / 100 B (101%)");
    expect(getProgressBarComponents()[0]?.value).toBe(100);
    expect(getSettingClasses()[2]).toContain("synch-storage-warning");
  });

  it("shows unlimited remote storage usage without a zero-byte limit", () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
      getSyncStatusLabel: () => "Sync: synced 100%",
      getSyncProgress: () => ({
        completedEntries: 12,
        totalEntries: 12,
      }),
      getStorageStatus: () => ({
        storageUsedBytes: 24_300_000,
        storageLimitBytes: 0,
      }),
    });

    tab.display();

    expect(getSettingNames().slice(1, 3)).toEqual([t("sync.label"), t("storage.label")]);
    expect(getSettingDescriptions()[0]).toBe(
      "synced 100% - 12 / 12",
    );
    expect(getSettingDescriptions()[1]).toBe("24.3 MB");
    expect(getProgressBarComponents()[0]?.value).toBe(0);
    expect(getSettingClasses()[2]).not.toContain("synch-storage-warning");
  });

  it("reserves the storage row before the websocket reports usage", () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
      getSyncStatusLabel: () => "Sync: synced 100%",
      getSyncProgress: () => ({
        completedEntries: 12,
        totalEntries: 12,
      }),
      getStorageStatus: () => null,
    });

    tab.display();

    expect(getSettingNames().slice(1, 3)).toEqual([t("sync.label"), t("storage.label")]);
    expect(getSettingDescriptions()[0]).toBe("synced 100% - 12 / 12");
    expect(getSettingDescriptions()[1]).toBe(t("storage.checking"));
    expect(getProgressBarComponents().map(({ value }) => value)).toEqual([
      0,
    ]);
  });
});

function getSyncSpinnerElements() {
  return getCreatedElements().filter((element) =>
    element.classes.includes("synch-sync-spinner"),
  );
}

function getFileSizeWarningElements() {
  return getCreatedElements().filter((element) =>
    element.classes.includes("synch-sync-file-size-warning-icon"),
  );
}
