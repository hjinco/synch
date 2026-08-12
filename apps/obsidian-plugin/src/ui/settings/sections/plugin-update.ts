import type { App, Setting } from "obsidian";

import { t } from "../../../i18n";
import type { AppWithSettings } from "../../contracts";
import type { SynchSettingsController } from "../controller";

/** Obsidian's built-in settings tab where plugin updates are installed. */
const COMMUNITY_PLUGINS_TAB_ID = "community-plugins";

export interface PluginUpdateRowContent {
  name: string;
  desc: string;
}

/**
 * First settings row, present only while a plugin update is available or
 * required (see {@link getPluginUpdateRowContent}). Its button jumps to
 * Obsidian's Community plugins tab, where the update is installed.
 */
export function populatePluginUpdateSetting(
  setting: Setting,
  app: App,
  controller: SynchSettingsController,
): void {
  const content = getPluginUpdateRowContent(controller);
  if (content === null) {
    return;
  }

  setting.setName(content.name).setDesc(content.desc);
  setting.addButton((button) =>
    button
      .setButtonText(t("plugin.openCommunityPlugins"))
      .setCta()
      .onClick(() => {
        (app as AppWithSettings).setting?.openTabById(COMMUNITY_PLUGINS_TAB_ID);
      }),
  );
}

/**
 * Returns what the plugin-update row should show, or null when the row must
 * not exist at all. Callers omit the row's definition entirely in the null
 * case — hiding it via a `visible` predicate would leave a hidden element
 * whose row divider still renders in the settings tab.
 */
export function getPluginUpdateRowContent(
  controller: SynchSettingsController,
): PluginUpdateRowContent | null {
  const serverCompatibility = controller.getServerCompatibilityStatus();
  if (
    serverCompatibility.state === "update_required" ||
    serverCompatibility.state === "incompatible"
  ) {
    return {
      name: t("plugin.updateRequired"),
      desc: serverCompatibility.message,
    };
  }

  const updateStatus = controller.getCommunityPluginUpdateStatus();
  if (updateStatus.state === "update_available") {
    return {
      name: t("plugin.updateAvailable"),
      desc: t("plugin.updateAvailableDesc", {
        version: updateStatus.latestVersion,
      }),
    };
  }

  return null;
}
