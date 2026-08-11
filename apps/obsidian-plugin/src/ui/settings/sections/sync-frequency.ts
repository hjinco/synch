import { Setting } from "obsidian";
import { t } from "../../../i18n";
import type { SynchSettingsController } from "../controller";

export function renderSyncFrequencySettings(
  containerEl: HTMLElement,
  controller: SynchSettingsController,
  hasConnectedRemoteVault: boolean,
): void {
  const serverCompatibility = controller.getServerCompatibilityStatus();
  if (
    !hasConnectedRemoteVault ||
    serverCompatibility.state === "update_required" ||
    serverCompatibility.state === "incompatible"
  ) {
    return;
  }

  new Setting(containerEl).setName(t("sync.frequency")).setHeading();
  new Setting(containerEl)
    .setDesc(t("sync.frequencyDesc"))
    .addDropdown((dropdown) =>
      dropdown
        .addOption("0", t("sync.frequencyRealtime"))
        .addOption("30000", t("sync.frequency30Seconds"))
        .addOption("60000", t("sync.frequency1Minute"))
        .addOption("180000", t("sync.frequency3Minutes"))
        .addOption("300000", t("sync.frequency5Minutes"))
        .addOption("600000", t("sync.frequency10Minutes"))
        .addOption("900000", t("sync.frequency15Minutes"))
        .addOption("1200000", t("sync.frequency20Minutes"))
        .addOption("1800000", t("sync.frequency30Minutes"))
        .setValue(String(controller.getSyncIntervalMs()))
        .onChange(async (value) => {
          await controller.setSyncIntervalMs(Number(value));
        }),
    );
}
