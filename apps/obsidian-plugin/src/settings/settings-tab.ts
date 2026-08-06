import { App, Plugin, PluginSettingTab, Setting } from "obsidian";

import { getServerDeployment } from "../config";
import { t } from "../i18n";
import type { SynchUiEvent } from "../plugin/ui-events";
import type { SynchSettingsController } from "./controller";
import {
  renderApiBaseUrlSetting,
  renderAuthenticationSetting,
  renderFileSyncSettings,
  renderNetworkConnectionRequiredSetting,
  renderRemoteVaultSettings,
  renderSettingsHeading,
  renderSubscriptionSetting,
  renderSyncFrequencySettings,
  renderSyncStatusSetting,
  type SyncStatusSettingControls,
} from "./settings-tab/sections";

export class SynchSettingTab extends PluginSettingTab {
  private isVisible = false;
  private syncStatusControls: SyncStatusSettingControls | null = null;
  private showSelfHostedServerUrl: boolean | null = null;

  constructor(
    app: App,
    plugin: Plugin,
    private readonly controller: SynchSettingsController,
  ) {
    super(app, plugin);
  }

  display(): void {
    this.isVisible = true;
    this.render();
  }

  refresh(): void {
    if (!this.isVisible) {
      return;
    }

    this.render();
  }

  refreshFileSizeBlockedWarning(): void {
    this.syncStatusControls?.refreshFileSizeBlockedWarning();
  }

  handleUiEvent(event: SynchUiEvent): void {
    if (!this.isVisible) {
      return;
    }

    switch (event.type) {
      case "sync-status-changed":
        this.syncStatusControls?.refreshSyncStatus();
        return;
      case "storage-status-changed":
        this.syncStatusControls?.refreshStorageStatus();
        return;
      case "file-size-blocked-changed":
        this.refreshFileSizeBlockedWarning();
        return;
    }
  }

  hide(): void {
    this.isVisible = false;
    this.syncStatusControls = null;
    super.hide();
  }

  private render(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.syncStatusControls = null;
    const hasConnectedRemoteVault = this.controller.hasConnectedRemoteVault();
    const hasAuthenticatedSession = this.controller.hasAuthenticatedSession();
    const isOfficialCloud =
      getServerDeployment(this.controller.getApiBaseUrl()) === "official_cloud";
    const authReadiness = this.controller.getAuthReadiness();
    const isDeviceLoginInProgress = this.controller.isDeviceLoginInProgress();
    const canChangeApiBaseUrl =
      !hasAuthenticatedSession &&
      !isDeviceLoginInProgress &&
      !hasConnectedRemoteVault;

    void this.controller.ensureCommunityPluginUpdateCheck();
    renderSettingsHeading(containerEl, this.controller);

    if (authReadiness.state === "pending_network") {
      renderNetworkConnectionRequiredSetting(containerEl);
      return;
    }

    if (hasAuthenticatedSession && isOfficialCloud) {
      void this.controller.ensureSubscriptionStatusCheck();
    }

    if (hasAuthenticatedSession) {
      this.syncStatusControls = renderSyncStatusSetting(
        containerEl,
        this.controller,
        hasConnectedRemoteVault,
        () => this.refresh(),
      );
    } else {
      new Setting(containerEl).setName(t("account")).setHeading();
    }

    renderAuthenticationSetting(
      containerEl,
      this.controller,
      isDeviceLoginInProgress,
      () => this.refresh(),
    );

    if (hasAuthenticatedSession && isOfficialCloud) {
      renderSubscriptionSetting(containerEl, this.controller, () => this.refresh());
    }

    if (!hasAuthenticatedSession) {
      new Setting(containerEl).setName(t("server.heading")).setHeading();
      renderApiBaseUrlSetting(containerEl, this.controller, {
        canChangeApiBaseUrl,
        hasConnectedRemoteVault,
        isDeviceLoginInProgress,
        showSelfHostedServerUrl:
          this.showSelfHostedServerUrl ?? !isOfficialCloud,
        onShowSelfHostedServerUrlChange: (value) => {
          this.showSelfHostedServerUrl = value;
          this.refresh();
        },
      });
      return;
    }

    renderRemoteVaultSettings(
      this.app,
      containerEl,
      this.controller,
      hasConnectedRemoteVault,
      () => this.refresh(),
    );
    renderFileSyncSettings(this.app, containerEl, this.controller, () => this.refresh());
    renderSyncFrequencySettings(
      containerEl,
      this.controller,
      hasConnectedRemoteVault,
    );
  }

}
