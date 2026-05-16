import { App, Notice, setIcon, setTooltip, Setting } from "obsidian";

import { getDefaultApiBaseUrl } from "../../config";
import { getSynchLocale, t } from "../../i18n";
import type {
  SynchFileRules,
  SynchSubscriptionStatus,
  SynchVaultConfigSyncRules,
} from "../../plugin/view-models";
import { isStorageWarningStatus } from "../../utils/storage-warning";
import type { SynchSettingsController } from "../controller";
import {
  formatStorageDescription,
  formatSyncDescription,
  getStoragePercent,
  shouldShowSyncSpinner,
} from "./format";
import {
  DeletedFilesModal,
  ExcludedFoldersModal,
  IncludedHiddenFoldersModal,
} from "./modals";

type RefreshSettings = () => void;

export interface SyncStatusSettingControls {
  refreshSyncStatus(): void;
  refreshStorageStatus(): void;
  refreshFileSizeBlockedWarning(): void;
}

interface FileSizeBlockedWarningControls {
  refreshFileSizeBlockedWarning(): void;
}

interface ProgressBarControl {
  setValue(value: number): ProgressBarControl;
}

export function renderSettingsHeading(
  containerEl: HTMLElement,
  controller: SynchSettingsController,
): void {
  const updateStatus = controller.getPluginUpdateStatus();
  const heading = new Setting(containerEl).setName("Synch").setHeading();
  if (updateStatus.state === "update_required") {
    heading.settingEl.addClass("synch-plugin-update-available");
    heading.controlEl.createSpan({
      cls: "synch-plugin-update-badge",
      text: t("plugin.updateRequired"),
    });
    return;
  }

  if (updateStatus.state !== "update_available") {
    return;
  }

  heading.settingEl.addClass("synch-plugin-update-available");
  heading.controlEl.createSpan({
    cls: "synch-plugin-update-badge",
    text: t("plugin.latestAvailable"),
  });
}

export function renderApiBaseUrlSetting(
  containerEl: HTMLElement,
  controller: SynchSettingsController,
  options: {
    canChangeApiBaseUrl: boolean;
    hasConnectedRemoteVault: boolean;
    isDeviceLoginInProgress: boolean;
  },
): void {
  const apiBaseUrl = controller.getApiBaseUrl();
  const visibleApiBaseUrl = apiBaseUrl === getDefaultApiBaseUrl() ? "" : apiBaseUrl;
  let apiBaseUrlInput = visibleApiBaseUrl;
  new Setting(containerEl)
    .setName(t("server.url"))
    .setDesc(
      options.isDeviceLoginInProgress
        ? t("server.descFinishSignIn")
        : options.hasConnectedRemoteVault
          ? t("server.descDisconnectVault")
          : t("server.descDefault"),
    )
    .addText((text) =>
      text
        .setPlaceholder(t("server.default"))
        .setValue(visibleApiBaseUrl)
        .setDisabled(!options.canChangeApiBaseUrl)
        .onChange((value) => {
          apiBaseUrlInput = value;
        }),
    )
    .addButton((button) =>
      button
        .setButtonText(t("save"))
        .setDisabled(!options.canChangeApiBaseUrl)
        .onClick(async () => {
          try {
            await controller.updateApiBaseUrl(apiBaseUrlInput);
            new Notice(t("server.saved"));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            new Notice(message);
          }
        }),
    );
}

export function renderSyncStatusSetting(
  containerEl: HTMLElement,
  controller: SynchSettingsController,
  hasConnectedRemoteVault: boolean,
): SyncStatusSettingControls | null {
  const updateStatus = controller.getPluginUpdateStatus();
  if (updateStatus.state === "update_required") {
    new Setting(containerEl)
      .setName(t("sync.paused"))
      .setDesc(updateStatus.message);
    return null;
  }

  if (!hasConnectedRemoteVault) {
    new Setting(containerEl)
      .setName(t("sync.label"))
      .setDesc(t("sync.connectRemoteVault"));
    return null;
  }

  const storageStatus = controller.getStorageStatus();
  const getSyncDescription = (): string =>
    formatSyncDescription(
      controller.getSyncStatusLabel(),
      controller.getSyncProgress(),
    );
  const initialSyncDescription = getSyncDescription();
  const syncSetting = new Setting(containerEl)
    .setName(t("sync.label"))
    .setDesc(initialSyncDescription);
  syncSetting.descEl.empty();
  const syncDescriptionEl = syncSetting.descEl.createSpan({
    text: initialSyncDescription,
  });
  const refreshSyncDescription = (): void => {
    syncDescriptionEl.setText(getSyncDescription());
  };
  const fileSizeWarning = createFileSizeBlockedWarningControls(syncSetting, controller);
  fileSizeWarning.refreshFileSizeBlockedWarning();
  let spinnerEl: HTMLElement | null = null;
  const refreshSyncSpinner = (): void => {
    const shouldShow = shouldShowSyncSpinner(controller.getSyncState());
    if (shouldShow && !spinnerEl) {
      spinnerEl = syncSetting.nameEl.createSpan({
        cls: "synch-sync-spinner",
      });
      spinnerEl.setAttribute("aria-hidden", "true");
      setIcon(spinnerEl, "loader-circle");
      return;
    }

    if (!shouldShow && spinnerEl) {
      spinnerEl.remove();
      spinnerEl = null;
    }
  };
  refreshSyncSpinner();
  syncSetting.addButton((button) =>
    button
      .setButtonText(controller.isSyncEnabled() ? t("sync.stop") : t("sync.start"))
      .onClick(async () => {
        await controller.setSyncEnabled(!controller.isSyncEnabled());
      }),
  );

  let storageProgressBar: ProgressBarControl | null = null;
  const storageSetting = new Setting(containerEl)
    .setName(t("storage.label"))
    .setDesc(storageStatus ? formatStorageDescription(storageStatus) : t("storage.checking"))
    .addProgressBar((progressBar) => {
      storageProgressBar = progressBar;
      progressBar.setValue(storageStatus ? getStoragePercent(storageStatus) : 0);
    });
  if (isStorageWarningStatus(storageStatus)) {
    storageSetting.settingEl.addClass("synch-storage-warning");
  }

  return {
    refreshSyncStatus(): void {
      refreshSyncDescription();
      refreshSyncSpinner();
    },
    refreshStorageStatus(): void {
      const nextStorageStatus = controller.getStorageStatus();
      storageSetting.setDesc(
        nextStorageStatus
          ? formatStorageDescription(nextStorageStatus)
          : t("storage.checking"),
      );
      storageProgressBar?.setValue(
        nextStorageStatus ? getStoragePercent(nextStorageStatus) : 0,
      );
      storageSetting.settingEl.toggleClass(
        "synch-storage-warning",
        isStorageWarningStatus(nextStorageStatus),
      );
    },
    refreshFileSizeBlockedWarning: fileSizeWarning.refreshFileSizeBlockedWarning,
  };
}

function createFileSizeBlockedWarningControls(
  syncSetting: Setting,
  controller: SynchSettingsController,
): FileSizeBlockedWarningControls {
  let run = 0;
  let icon: HTMLElement | null = null;

  async function refresh(currentRun: number): Promise<void> {
    let blockedFileCount = 0;
    try {
      blockedFileCount = (await controller.listFileSizeBlockedFiles()).length;
    } catch {
      return;
    }
    if (currentRun !== run) {
      return;
    }

    icon?.remove();
    icon = null;
    if (blockedFileCount <= 0) {
      return;
    }

    icon = syncSetting.descEl.createSpan({
      cls: "synch-sync-file-size-warning-icon",
    });
    icon.setAttribute("aria-hidden", "true");
    setIcon(icon, "triangle-alert");
    setTooltip(icon, formatFileSizeBlockedTooltip(blockedFileCount), {
      delay: 1,
      placement: "right",
    });
  }

  return {
    refreshFileSizeBlockedWarning(): void {
      run += 1;
      void refresh(run);
    },
  };
}

function formatFileSizeBlockedTooltip(blockedFileCount: number): string {
  return t("sync.fileSizeBlocked", { count: blockedFileCount });
}

export function renderNetworkConnectionRequiredSetting(
  containerEl: HTMLElement,
): void {
  new Setting(containerEl)
    .setName(t("network.required"))
    .setDesc(t("network.requiredDesc"));
}

export function renderAuthenticationSetting(
  containerEl: HTMLElement,
  controller: SynchSettingsController,
  isDeviceLoginInProgress: boolean,
  refresh: RefreshSettings,
): void {
  const authSetting = new Setting(containerEl)
    .setName(t("authentication"))
    .setDesc(controller.getAuthStatusLabel());

  if (!controller.hasAuthenticatedSession()) {
    authSetting.addButton((button) =>
      button
        .setButtonText(
          isDeviceLoginInProgress
            ? t("auth.openSignInAgain")
            : t("auth.signInOnThisDevice"),
        )
        .onClick(async () => {
          await controller.beginDeviceLogin();
          refresh();
        }),
    );
  } else {
    authSetting.addButton((button) =>
      button
        .setButtonText(t("auth.signOut"))
        .onClick(async () => {
          await controller.signOutDevice();
          refresh();
        }),
    );
  }
}

export function renderSubscriptionSetting(
  containerEl: HTMLElement,
  controller: SynchSettingsController,
  refresh: RefreshSettings,
): void {
  const status = controller.getSubscriptionStatus();
  const setting = new Setting(containerEl)
    .setName(t("subscription.label"))
    .setDesc(formatSubscriptionDescription(status));

  if (status.state === "failed") {
    setting.addButton((button) =>
      button.setButtonText(t("refresh")).onClick(async () => {
        await controller.retrySubscriptionStatusCheck();
        refresh();
      }),
    );
    return;
  }

  if (status.state !== "loaded") {
    return;
  }

  if (status.active) {
    setting.addButton((button) =>
      button.setButtonText(t("subscription.manage")).onClick(() => {
        controller.openBillingManagementPage();
      }),
    );
    return;
  }

  setting.addButton((button) =>
    button.setButtonText(t("subscription.upgrade")).onClick(() => {
      controller.openPricingPage();
    }),
  );
}

function formatSubscriptionDescription(
  status: SynchSubscriptionStatus,
): string {
  if (status.state === "idle" || status.state === "checking") {
    return t("subscription.checking");
  }

  if (status.state === "failed") {
    return t("subscription.failed");
  }

  if (status.state !== "loaded") {
    return t("subscription.checking");
  }

  const planName = formatSubscriptionPlanName(status.planId);
  if (status.active && status.cancelAtPeriodEnd && status.periodEnd) {
    return t("subscription.canceling", {
      plan: planName,
      periodEnd: formatSubscriptionPeriodEnd(status.periodEnd),
    });
  }

  return t("subscription.currentPlan", { plan: planName });
}

function formatSubscriptionPlanName(planId: string): string {
  switch (planId) {
    case "starter":
      return t("subscription.starterPlan");
    default:
      return t("subscription.freePlan");
  }
}

function formatSubscriptionPeriodEnd(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(getSynchLocale(), {
    dateStyle: "medium",
  }).format(date);
}

export function renderRemoteVaultSettings(
  app: App,
  containerEl: HTMLElement,
  controller: SynchSettingsController,
  hasConnectedRemoteVault: boolean,
  refresh: RefreshSettings,
): void {
  new Setting(containerEl)
    .setName(t("vault.manage"))
    .setDesc(t("vault.manageDesc"))
    .addButton((button) =>
      button.setButtonText(t("vault.manageRemote")).onClick(() => {
        controller.openRemoteVaultManagementPage();
      }),
    );

  const vaultSetting = new Setting(containerEl)
    .setName(t("vault.setting"))
    .setDesc(controller.getRemoteVaultStatusLabel());

  if (hasConnectedRemoteVault) {
    vaultSetting.addButton((button) =>
      button.setButtonText(t("vault.disconnect")).onClick(async () => {
        await controller.disconnectRemoteVault();
        refresh();
      }),
    );

    new Setting(containerEl)
      .setName(t("deleted.header"))
      .setDesc(t("vault.deletedFilesDesc"))
      .addButton((button) =>
        button.setButtonText(t("vault.viewDeletedFiles")).onClick(() => {
          new DeletedFilesModal(app, {
            listDeletedFiles: async (before, limit) =>
              await controller.listDeletedFiles(before, limit),
            previewDeletedFile: async (entryId, fallbackPath) =>
              await controller.previewDeletedFile(entryId, fallbackPath),
            restoreDeletedFiles: async (files) => {
              const result = await controller.restoreDeletedFiles(files);
              refresh();
              return result;
            },
            purgeDeletedFiles: async (files) => {
              const result = await controller.purgeDeletedFiles(files);
              refresh();
              return result;
            },
          }).open();
        }),
      );

    if (controller.getRemoteVaultSyncFormatVersion() === 1) {
      new Setting(containerEl)
        .setName(t("vault.formatUpgradeTitle"))
        .setDesc(t("vault.formatUpgradeDesc"))
        .addButton((button) =>
          button.setButtonText(t("vault.manageRemote")).onClick(() => {
            controller.openRemoteVaultManagementPage();
          }),
        );
    }
    return;
  }

  vaultSetting
    .addButton((button) =>
      button.setButtonText(t("vault.create")).onClick(async () => {
        await controller.createRemoteVaultFromPrompt();
        refresh();
      }),
    )
    .addButton((button) =>
      button.setButtonText(t("vault.connect")).onClick(async () => {
        await controller.connectRemoteVaultFromPrompt();
        refresh();
      }),
    );
}

export function renderFileSyncSettings(
  app: App,
  containerEl: HTMLElement,
  controller: SynchSettingsController,
  refresh: RefreshSettings,
): void {
  const fileRules = controller.getSyncFileRules();

  new Setting(containerEl).setName(t("fileSync.header")).setHeading();

  addFileRuleToggle(
    containerEl,
    t("images"),
    t("fileSync.imagesDesc"),
    fileRules,
    "includeImages",
    controller,
    refresh,
  );
  addFileRuleToggle(
    containerEl,
    t("audio"),
    t("fileSync.audioDesc"),
    fileRules,
    "includeAudio",
    controller,
    refresh,
  );
  addFileRuleToggle(
    containerEl,
    t("videos"),
    t("fileSync.videosDesc"),
    fileRules,
    "includeVideos",
    controller,
    refresh,
  );
  addFileRuleToggle(
    containerEl,
    "PDF",
    t("fileSync.pdfDesc"),
    fileRules,
    "includePdf",
    controller,
    refresh,
  );
  addFileRuleToggle(
    containerEl,
    t("fileSync.other"),
    t("fileSync.otherDesc"),
    fileRules,
    "includeOtherFiles",
    controller,
    refresh,
  );

  new Setting(containerEl)
    .setName(t("excluded.header"))
    .setDesc(
      fileRules.excludedFolders.length > 0
        ? t("excluded.count", { count: fileRules.excludedFolders.length })
        : t("excluded.none"),
    )
    .addButton((button) =>
      button.setButtonText(t("manage")).onClick(() => {
        new ExcludedFoldersModal(app, {
          availableFolders: controller.listSelectableExcludedFolderPaths(),
          initialSelection: fileRules.excludedFolders,
          onSubmit: async (paths) => {
            await controller.updateExcludedFolders(paths);
            refresh();
          },
        }).open();
      }),
    );

  for (const folder of fileRules.excludedFolders) {
    new Setting(containerEl)
      .setName(folder)
      .setDesc(t("excluded.folderDesc"))
      .addButton((button) =>
        button.setButtonText(t("excluded.remove")).onClick(async () => {
          await controller.updateExcludedFolders(
            fileRules.excludedFolders.filter((value) => value !== folder),
          );
          refresh();
        }),
      );
  }

  new Setting(containerEl)
    .setName(t("hiddenFolders.header"))
    .setDesc(
      fileRules.includedHiddenFolders.length > 0
        ? t("hiddenFolders.count", {
            count: fileRules.includedHiddenFolders.length,
          })
        : t("hiddenFolders.none"),
    )
    .addButton((button) =>
      button.setButtonText(t("manage")).onClick(async () => {
        new IncludedHiddenFoldersModal(app, {
          availableFolders: await controller.listSelectableIncludedHiddenFolderPaths(),
          initialSelection: fileRules.includedHiddenFolders,
          onSubmit: async (paths) => {
            await controller.updateIncludedHiddenFolders(paths);
            refresh();
          },
        }).open();
      }),
    );

  for (const folder of fileRules.includedHiddenFolders) {
    new Setting(containerEl)
      .setName(folder)
      .setDesc(t("hiddenFolders.folderDesc"))
      .addButton((button) =>
        button.setButtonText(t("hiddenFolders.remove")).onClick(async () => {
          await controller.updateIncludedHiddenFolders(
            fileRules.includedHiddenFolders.filter((value) => value !== folder),
          );
          refresh();
        }),
      );
  }

  containerEl.createEl("p", {
    cls: "synch-setting-hint",
    text: t("fileSync.hint"),
  });

  renderVaultConfigSyncSettings(containerEl, controller, refresh);
}

function renderVaultConfigSyncSettings(
  containerEl: HTMLElement,
  controller: SynchSettingsController,
  refresh: RefreshSettings,
): void {
  const rules = controller.getVaultConfigSyncRules();

  new Setting(containerEl)
    .setName(t("configSync.header"))
    .setDesc(t("configSync.desc"))
    .addToggle((toggle) =>
      toggle.setValue(rules.enabled).onChange(async (value) => {
        await controller.updateVaultConfigSyncRule("enabled", value);
        refresh();
      }),
    );

  if (!rules.enabled) {
    return;
  }

  addVaultConfigRuleToggle(
    containerEl,
    t("configSync.mainSettings"),
    t("configSync.mainSettingsDesc"),
    rules,
    "mainSettings",
    controller,
    refresh,
  );
  addVaultConfigRuleToggle(
    containerEl,
    t("configSync.appearance"),
    t("configSync.appearanceDesc"),
    rules,
    "appearance",
    controller,
    refresh,
  );
  addVaultConfigRuleToggle(
    containerEl,
    t("configSync.themesAndSnippets"),
    t("configSync.themesAndSnippetsDesc"),
    rules,
    "themesAndSnippets",
    controller,
    refresh,
  );
  addVaultConfigRuleToggle(
    containerEl,
    t("configSync.hotkeys"),
    t("configSync.hotkeysDesc"),
    rules,
    "hotkeys",
    controller,
    refresh,
  );
  addVaultConfigRuleToggle(
    containerEl,
    t("configSync.corePluginList"),
    t("configSync.corePluginListDesc"),
    rules,
    "corePluginList",
    controller,
    refresh,
  );
  addVaultConfigRuleToggle(
    containerEl,
    t("configSync.corePluginData"),
    t("configSync.corePluginDataDesc"),
    rules,
    "corePluginData",
    controller,
    refresh,
  );
  addVaultConfigRuleToggle(
    containerEl,
    t("configSync.communityPluginList"),
    t("configSync.communityPluginListDesc"),
    rules,
    "communityPluginList",
    controller,
    refresh,
  );
  addVaultConfigRuleToggle(
    containerEl,
    t("configSync.communityPluginFiles"),
    t("configSync.communityPluginFilesDesc"),
    rules,
    "communityPluginFiles",
    controller,
    refresh,
  );
  addVaultConfigRuleToggle(
    containerEl,
    t("configSync.communityPluginData"),
    t("configSync.communityPluginDataDesc"),
    rules,
    "communityPluginData",
    controller,
    refresh,
  );
}

function addVaultConfigRuleToggle<K extends keyof SynchVaultConfigSyncRules>(
  containerEl: HTMLElement,
  name: string,
  description: string,
  rules: SynchVaultConfigSyncRules,
  key: K,
  controller: SynchSettingsController,
  refresh: RefreshSettings,
): void {
  new Setting(containerEl)
    .setName(name)
    .setDesc(description)
    .addToggle((toggle) =>
      toggle
        .setValue(rules[key] as boolean)
        .onChange(async (value) => {
          await controller.updateVaultConfigSyncRule(
            key,
            value as SynchVaultConfigSyncRules[K],
          );
          refresh();
        }),
    );
}

function addFileRuleToggle<K extends keyof SynchFileRules>(
  containerEl: HTMLElement,
  name: string,
  description: string,
  fileRules: SynchFileRules,
  key: K,
  controller: SynchSettingsController,
  refresh: RefreshSettings,
): void {
  new Setting(containerEl)
    .setName(name)
    .setDesc(description)
    .addToggle((toggle) =>
      toggle.setValue(fileRules[key] as boolean).onChange(async (value) => {
        await controller.updateSyncFileRule(key, value as SynchFileRules[K]);
        refresh();
      }),
    );
}
