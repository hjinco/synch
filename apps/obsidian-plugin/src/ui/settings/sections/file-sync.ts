import { App, Setting } from "obsidian";
import { t } from "../../../i18n";
import type { SynchFileRules, SynchVaultConfigSyncRules } from "../../contracts";
import type { SynchSettingsController } from "../controller";
import { ExcludedFoldersModal, IncludedHiddenFoldersModal } from "../modals";
import { RefreshSettings } from "./shared";

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
  );
  addFileRuleToggle(
    containerEl,
    t("audio"),
    t("fileSync.audioDesc"),
    fileRules,
    "includeAudio",
    controller,
  );
  addFileRuleToggle(
    containerEl,
    t("videos"),
    t("fileSync.videosDesc"),
    fileRules,
    "includeVideos",
    controller,
  );
  addFileRuleToggle(
    containerEl,
    "PDF",
    t("fileSync.pdfDesc"),
    fileRules,
    "includePdf",
    controller,
  );
  addFileRuleToggle(
    containerEl,
    t("fileSync.other"),
    t("fileSync.otherDesc"),
    fileRules,
    "includeOtherFiles",
    controller,
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
  );
  addVaultConfigRuleToggle(
    containerEl,
    t("configSync.appearance"),
    t("configSync.appearanceDesc"),
    rules,
    "appearance",
    controller,
  );
  addVaultConfigRuleToggle(
    containerEl,
    t("configSync.themesAndSnippets"),
    t("configSync.themesAndSnippetsDesc"),
    rules,
    "themesAndSnippets",
    controller,
  );
  addVaultConfigRuleToggle(
    containerEl,
    t("configSync.hotkeys"),
    t("configSync.hotkeysDesc"),
    rules,
    "hotkeys",
    controller,
  );
  addVaultConfigRuleToggle(
    containerEl,
    t("configSync.corePluginList"),
    t("configSync.corePluginListDesc"),
    rules,
    "corePluginList",
    controller,
  );
  addVaultConfigRuleToggle(
    containerEl,
    t("configSync.corePluginData"),
    t("configSync.corePluginDataDesc"),
    rules,
    "corePluginData",
    controller,
  );
  addVaultConfigRuleToggle(
    containerEl,
    t("configSync.communityPluginList"),
    t("configSync.communityPluginListDesc"),
    rules,
    "communityPluginList",
    controller,
  );
  addVaultConfigRuleToggle(
    containerEl,
    t("configSync.communityPluginFiles"),
    t("configSync.communityPluginFilesDesc"),
    rules,
    "communityPluginFiles",
    controller,
  );
  addVaultConfigRuleToggle(
    containerEl,
    t("configSync.communityPluginData"),
    t("configSync.communityPluginDataDesc"),
    rules,
    "communityPluginData",
    controller,
  );
}

function addVaultConfigRuleToggle<K extends keyof SynchVaultConfigSyncRules>(
  containerEl: HTMLElement,
  name: string,
  description: string,
  rules: SynchVaultConfigSyncRules,
  key: K,
  controller: SynchSettingsController,
): void {
  new Setting(containerEl)
    .setName(name)
    .setDesc(description)
    .addToggle((toggle) =>
      toggle.setValue(rules[key]).onChange(async (value) => {
        await controller.updateVaultConfigSyncRule(key, value);
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
): void {
  new Setting(containerEl)
    .setName(name)
    .setDesc(description)
    .addToggle((toggle) =>
      toggle.setValue(fileRules[key] as boolean).onChange(async (value) => {
        await controller.updateSyncFileRule(key, value as SynchFileRules[K]);
      }),
    );
}
