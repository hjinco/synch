import { Notice, Setting } from "obsidian";
import { getServerDeployment } from "../../../config";
import { t } from "../../../i18n";
import type { SynchSettingsController } from "../controller";

export function renderApiBaseUrlSetting(
  containerEl: HTMLElement,
  controller: SynchSettingsController,
  options: {
    canChangeApiBaseUrl: boolean;
    hasConnectedRemoteVault: boolean;
    isDeviceLoginInProgress: boolean;
    showSelfHostedServerUrl: boolean;
    onShowSelfHostedServerUrlChange(value: boolean): void;
  },
): void {
  const apiBaseUrl = controller.getApiBaseUrl();
  const visibleApiBaseUrl =
    getServerDeployment(apiBaseUrl) === "official_cloud" ? "" : apiBaseUrl;
  let apiBaseUrlInput = visibleApiBaseUrl;
  const serverDescription = options.isDeviceLoginInProgress
    ? t("server.descFinishSignIn")
    : options.hasConnectedRemoteVault
      ? t("server.descDisconnectVault")
      : t("server.descDefault");

  new Setting(containerEl)
    .setName(t("server.mode"))
    .setDesc(serverDescription)
    .addToggle((toggle) =>
      toggle
        .setValue(options.showSelfHostedServerUrl)
        .setDisabled(!options.canChangeApiBaseUrl)
        .onChange(async (value) => {
          if (value) {
            options.onShowSelfHostedServerUrlChange(true);
            return;
          }

          try {
            await controller.updateApiBaseUrl("");
            new Notice(t("server.savedCloud"));
            options.onShowSelfHostedServerUrlChange(false);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            new Notice(t("server.saveFailed", { message }));
          }
        }),
    );

  if (!options.showSelfHostedServerUrl) {
    return;
  }

  new Setting(containerEl)
    .setName(t("server.url"))
    .setDesc(t("server.urlDesc"))
    .addText((text) =>
      text
        .setPlaceholder(t("server.placeholder"))
        .setValue(visibleApiBaseUrl)
        .setDisabled(!options.canChangeApiBaseUrl)
        .onChange((value) => {
          apiBaseUrlInput = value;
        }),
    )
    .addButton((button) =>
      button
        .setButtonText(t("save"))
        .setDisabled(!options.canChangeApiBaseUrl)
        .onClick(async () => {
          try {
            await controller.updateApiBaseUrl(apiBaseUrlInput);
            new Notice(t("server.saved"));
            options.onShowSelfHostedServerUrlChange(
              getServerDeployment(controller.getApiBaseUrl()) === "self_hosted",
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            new Notice(t("server.saveFailed", { message }));
          }
        }),
    );
}
