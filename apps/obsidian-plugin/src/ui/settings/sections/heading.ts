import { Setting } from "obsidian";
import { t } from "../../../i18n";
import type { SynchSettingsController } from "../controller";

export function renderSettingsHeading(
  containerEl: HTMLElement,
  controller: SynchSettingsController,
): void {
  const serverCompatibility = controller.getServerCompatibilityStatus();
  const communityUpdate = controller.getCommunityPluginUpdateStatus();
  const heading = new Setting(containerEl).setName("Synch").setHeading();
  if (
    serverCompatibility.state === "update_required" ||
    serverCompatibility.state === "incompatible"
  ) {
    heading.settingEl.addClass("synch-plugin-update-available");
    heading.controlEl.createSpan({
      cls: "synch-plugin-update-badge",
      text: t("plugin.updateRequired"),
    });
    return;
  }

  if (communityUpdate.state !== "update_available") {
    return;
  }

  heading.settingEl.addClass("synch-plugin-update-available");
  heading.controlEl.createSpan({
    cls: "synch-plugin-update-badge",
    text: t("plugin.latestAvailable"),
  });
}
