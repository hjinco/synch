import { App, Setting } from "obsidian";
import { t } from "../../../i18n";
import type { SynchSettingsController } from "../controller";
import { DeletedFilesModal } from "../modals";
import { RefreshSettings } from "./shared";

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

  if (!hasConnectedRemoteVault) {
    return;
  }

  const vaultSetting = new Setting(containerEl)
    .setName(t("vault.setting"))
    .setDesc(controller.getRemoteVaultStatusLabel());

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
}
