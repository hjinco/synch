import { Setting } from "obsidian";
import { t } from "../../../i18n";
import type { SynchSettingsController } from "../controller";
import { RefreshSettings } from "./shared";

export function populateAuthenticationSetting(
  authSetting: Setting,
  controller: SynchSettingsController,
  isDeviceLoginInProgress: boolean,
  refresh: RefreshSettings,
): void {
  authSetting
    .setName(t("authentication"))
    .setDesc(controller.getAuthStatusLabel());

  if (!controller.hasAuthenticatedSession()) {
    if (isDeviceLoginInProgress) {
      authSetting.addButton((button) =>
        button
          .setButtonText(t("auth.openSignInAgain"))
          .onClick(async () => {
            await controller.beginDeviceLogin();
            refresh();
          }),
      );
      authSetting.addButton((button) =>
        button.setButtonText(t("cancel")).onClick(() => {
          controller.cancelDeviceLogin();
          refresh();
        }),
      );
    } else {
      authSetting.addButton((button) =>
        button
          .setButtonText(t("auth.signInOnThisDevice"))
          .onClick(async () => {
            await controller.beginDeviceLogin();
            refresh();
          }),
      );
    }
  } else {
    authSetting.addButton((button) =>
      button
        .setButtonText(t("auth.signOut"))
        .onClick(async () => {
          await controller.signOutDevice();
          refresh();
        }),
    );
  }
}
