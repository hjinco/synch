import { Notice, type Plugin } from "obsidian";

import { t } from "../i18n";

export interface SynchCommandController {
  getAuthStatusLabel(): string;
  getRemoteVaultStatusLabel(): string;
  beginDeviceLogin(): Promise<void>;
  signOutDevice(): Promise<void>;
  createRemoteVaultFromPrompt(): Promise<void>;
  connectRemoteVaultFromPrompt(): Promise<void>;
  disconnectRemoteVault(): Promise<void>;
  openVersionHistoryPane(): Promise<void>;
  syncNow(): Promise<void>;
}

export function registerSynchCommands(
  plugin: Plugin,
  controller: SynchCommandController,
): void {
  plugin.addCommand({
    id: "sync-now",
    name: t("sync.now"),
    callback: async () => {
      await controller.syncNow();
    },
  });

  plugin.addCommand({
    id: "sign-in-on-this-device",
    name: t("auth.signInOnThisDevice"),
    callback: async () => {
      await controller.beginDeviceLogin();
    },
  });

  plugin.addCommand({
    id: "sign-out-on-this-device",
    name: t("auth.signOut"),
    callback: async () => {
      await controller.signOutDevice();
    },
  });

  plugin.addCommand({
    id: "show-auth-status",
    name: t("auth.showStatus"),
    callback: () => {
      new Notice(controller.getAuthStatusLabel());
    },
  });

  plugin.addCommand({
    id: "create-vault",
    name: t("vault.create"),
    callback: async () => {
      await controller.createRemoteVaultFromPrompt();
    },
  });

  plugin.addCommand({
    id: "connect-vault",
    name: t("vault.connect"),
    callback: async () => {
      await controller.connectRemoteVaultFromPrompt();
    },
  });

  plugin.addCommand({
    id: "disconnect-vault",
    name: t("vault.disconnect"),
    callback: async () => {
      await controller.disconnectRemoteVault();
    },
  });

  plugin.addCommand({
    id: "show-vault-status",
    name: t("vault.showStatus"),
    callback: () => {
      new Notice(controller.getRemoteVaultStatusLabel());
    },
  });

  plugin.addCommand({
    id: "open-version-history",
    name: t("version.header"),
    callback: async () => {
      await controller.openVersionHistoryPane();
    },
  });
}
