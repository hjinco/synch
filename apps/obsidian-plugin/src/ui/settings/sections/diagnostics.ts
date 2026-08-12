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
  setting
    .setName(t("diagnostics.header"))
    .setDesc(formatSyncDiagnosticsDescription(controller.getSyncLogs()))
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
      setting.setDesc(formatSyncDiagnosticsDescription(controller.getSyncLogs()));
    },
  };
}

function formatSyncDiagnosticsDescription(
  snapshot: ReturnType<SynchSettingsController["getSyncLogs"]>,
): string {
  return t("diagnostics.desc", { count: snapshot.count });
}
