import { setIcon, setTooltip, Setting } from "obsidian";
import { t } from "../../../i18n";
import type { SynchSettingsController } from "../controller";
import type { SynchStorageDisplayState } from "../../contracts";
import { formatStorageDescription, formatSyncDescription, getStoragePercent, shouldShowSyncSpinner } from "../format";
import {
  FileSizeBlockedWarningControls,
  ProgressBarControl,
  RefreshSettings,
  StorageRowSettingControls,
  SyncRowSettingControls,
} from "./shared";

export function populateSyncPausedSetting(setting: Setting, message: string): void {
  setting.setName(t("sync.paused")).setDesc(message);
}

export function populateVaultConnectSetting(
  setting: Setting,
  controller: SynchSettingsController,
  refresh: RefreshSettings,
): void {
  setting
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
}

export function populateSyncStatusSetting(
  syncSetting: Setting,
  controller: SynchSettingsController,
): SyncRowSettingControls {
  const getSyncDescription = (): string =>
    formatSyncDescription(
      controller.getSyncState(),
      controller.getSyncPercent(),
      controller.getSyncProgress(),
    );
  const initialSyncDescription = getSyncDescription();
  syncSetting.setName(t("sync.label")).setDesc(initialSyncDescription);
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

  return {
    refreshSyncStatus(): void {
      refreshSyncDescription();
      refreshSyncSpinner();
    },
    refreshFileSizeBlockedWarning: () => {
      fileSizeWarning.refreshFileSizeBlockedWarning();
    },
  };
}

export function populateStorageStatusSetting(
  storageSetting: Setting,
  controller: SynchSettingsController,
): StorageRowSettingControls {
  const storageStatus = controller.getStorageStatus();
  const storageDisplayState = controller.getStorageDisplayState();
  let storageProgressBar: ProgressBarControl | null = null;
  storageSetting
    .setName(t("storage.label"))
    .setDesc(formatStorageDescription(storageStatus, storageDisplayState))
    .addProgressBar((progressBar) => {
      storageProgressBar = progressBar;
      progressBar.setValue(storageStatus ? getStoragePercent(storageStatus) : 0);
    });
  applyStorageDisplayState(storageSetting, storageDisplayState);

  return {
    refreshStorageStatus(): void {
      const nextStorageStatus = controller.getStorageStatus();
      const nextStorageDisplayState = controller.getStorageDisplayState();
      storageSetting.setDesc(
        formatStorageDescription(nextStorageStatus, nextStorageDisplayState),
      );
      storageProgressBar?.setValue(
        nextStorageStatus ? getStoragePercent(nextStorageStatus) : 0,
      );
      applyStorageDisplayState(storageSetting, nextStorageDisplayState);
    },
  };
}

function applyStorageDisplayState(
  storageSetting: Setting,
  storageDisplayState: SynchStorageDisplayState,
): void {
  storageSetting.settingEl.toggleClass(
    "synch-storage-warning",
    storageDisplayState === "near_limit",
  );
  storageSetting.settingEl.toggleClass(
    "synch-storage-needs-more",
    storageDisplayState === "needs_more_storage",
  );
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
