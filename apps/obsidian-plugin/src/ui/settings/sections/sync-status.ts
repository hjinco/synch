import { setIcon, setTooltip, Setting } from "obsidian";
import { t } from "../../../i18n";
import { isStorageWarningStatus } from "../../../platform/storage-warning";
import type { SynchSettingsController } from "../controller";
import { formatStorageDescription, formatSyncDescription, getStoragePercent, shouldShowSyncSpinner } from "../format";
import { FileSizeBlockedWarningControls, ProgressBarControl, RefreshSettings, SyncStatusSettingControls } from "./shared";

export function renderSyncStatusSetting(
  containerEl: HTMLElement,
  controller: SynchSettingsController,
  hasConnectedRemoteVault: boolean,
  refresh: RefreshSettings,
): SyncStatusSettingControls | null {
  const serverCompatibility = controller.getServerCompatibilityStatus();
  if (
    serverCompatibility.state === "update_required" ||
    serverCompatibility.state === "incompatible"
  ) {
    new Setting(containerEl)
      .setName(t("sync.paused"))
      .setDesc(serverCompatibility.message);
    return null;
  }

  if (!hasConnectedRemoteVault) {
    new Setting(containerEl)
      .setName(t("sync.label"))
      .setDesc(t("sync.connectRemoteVault"))
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
  if (controller.getSyncIntervalMs() > 0) {
    syncSetting.addButton((button) =>
      button
        .setButtonText(t("sync.now"))
        .setDisabled(!controller.isSyncEnabled())
        .onClick(async () => {
          await controller.syncNow();
        }),
    );
  }

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
    refreshFileSizeBlockedWarning: () => {
      fileSizeWarning.refreshFileSizeBlockedWarning();
    },
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
