import { Setting } from "obsidian";
import { t } from "../../../i18n";
import type { SynchSettingsController } from "../controller";

/**
 * The "Synch" heading exists only to host the plugin-update badge; without
 * one it is redundant (the settings page already shows the plugin name) and
 * is hidden via its definition's `visible` predicate.
 */
export function populateSettingsHeading(
  heading: Setting,
  controller: SynchSettingsController,
): void {
  heading.setName("Synch").setHeading();
  const badgeText = getUpdateBadgeText(controller);
  if (badgeText === null) {
    return;
  }

  heading.settingEl.addClass("synch-plugin-update-available");
  heading.controlEl.createSpan({
    cls: "synch-plugin-update-badge",
    text: badgeText,
  });
}

export function hasUpdateBadge(controller: SynchSettingsController): boolean {
  return getUpdateBadgeText(controller) !== null;
}

function getUpdateBadgeText(controller: SynchSettingsController): string | null {
  const serverCompatibility = controller.getServerCompatibilityStatus();
  if (
    serverCompatibility.state === "update_required" ||
    serverCompatibility.state === "incompatible"
  ) {
    return t("plugin.updateRequired");
  }

  if (controller.getCommunityPluginUpdateStatus().state === "update_available") {
    return t("plugin.latestAvailable");
  }

  return null;
}
