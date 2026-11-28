import { App, Setting } from "obsidian";
import { t } from "../../../i18n";
import type { SynchSettingsController } from "../controller";
import { SyncLogsModal } from "../sync-logs-modal";
import { SyncDiagnosticsSettingControls } from "./shared";

export function populateSyncDiagnosticsSetting(
  setting: Setting,
  app: App,
  controller: SynchSettingsController,
): SyncDiagnosticsSettingControls {
  let displayedCount = controller.getSyncLogCount();
  setting
    .setName(t("diagnostics.header"))
    .setDesc(t("diagnostics.desc", { count: displayedCount }))
    .addButton((button) =>
      button.setButtonText(t("diagnostics.open")).onClick(() => {
        new SyncLogsModal(app, {
          getSyncLogs: () => controller.getSyncLogs(),
          clearSyncLogs: () => controller.clearSyncLogs(),
          subscribeSyncLogs: (listener) => controller.subscribeSyncLogs(listener),
        }).open();
      }),
    );

  return {
    refreshSyncLogs(): void {
      const count = controller.getSyncLogCount();
      if (count === displayedCount) return;
      displayedCount = count;
      setting.setDesc(t("diagnostics.desc", { count }));
    },
  };
}
