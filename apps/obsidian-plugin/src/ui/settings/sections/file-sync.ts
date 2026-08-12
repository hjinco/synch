import { App, Setting } from "obsidian";
import { t } from "../../../i18n";
import type { SynchFileRules } from "../../contracts";
import type { SynchSettingsController } from "../controller";
import { ExcludedFoldersModal, IncludedHiddenFoldersModal } from "../modals";
import { RefreshSettings } from "./shared";

export function populateExcludedFoldersSetting(
  setting: Setting,
  app: App,
  controller: SynchSettingsController,
  refresh: RefreshSettings,
  fileRules: SynchFileRules,
): void {
  setting
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
}

export function populateExcludedFolderRow(
  setting: Setting,
  controller: SynchSettingsController,
  refresh: RefreshSettings,
  fileRules: SynchFileRules,
  folder: string,
): void {
  setting
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

export function populateHiddenFoldersSetting(
  setting: Setting,
  app: App,
  controller: SynchSettingsController,
  refresh: RefreshSettings,
  fileRules: SynchFileRules,
): void {
  setting
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
}

export function populateHiddenFolderRow(
  setting: Setting,
  controller: SynchSettingsController,
  refresh: RefreshSettings,
  fileRules: SynchFileRules,
  folder: string,
): void {
  setting
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
