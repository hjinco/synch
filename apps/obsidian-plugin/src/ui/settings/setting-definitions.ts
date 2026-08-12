import type {
  App,
  SettingDefinition,
  SettingDefinitionItem,
} from "obsidian";

import { getServerDeployment } from "../../config";
import { t } from "../../i18n";
import type { SynchFileRules, SynchVaultConfigSyncRules } from "../contracts";
import type { SynchSettingsController } from "./controller";
import {
  hasUpdateBadge,
  populateAuthenticationSetting,
  populateDeletedFilesSetting,
  populateExcludedFolderRow,
  populateExcludedFoldersSetting,
  populateHiddenFolderRow,
  populateHiddenFoldersSetting,
  populateServerModeSetting,
  populateServerUrlSetting,
  populateSettingsHeading,
  populateStorageStatusSetting,
  populateSubscriptionSetting,
  populateSyncDiagnosticsSetting,
  populateSyncPausedSetting,
  populateSyncStatusSetting,
  populateVaultConnectSetting,
  populateVaultConnectionSetting,
  populateVaultFormatUpgradeSetting,
  populateVaultManageSetting,
  type ApiBaseUrlSettingOptions,
} from "./sections";
import type {
  StorageRowSettingControls,
  SyncDiagnosticsSettingControls,
  SyncRowSettingControls,
} from "./sections";

type BooleanKeys<T> = Extract<
  { [K in keyof T]: T[K] extends boolean ? K : never }[keyof T],
  string
>;

// Control keys bind toggles/dropdowns only; folder-list rules go through
// their own modals, so array-valued rule keys are deliberately excluded.
export type SynchSettingControlKey =
  | "syncIntervalMs"
  | `fileRules.${BooleanKeys<SynchFileRules>}`
  | `vaultConfigSync.${BooleanKeys<SynchVaultConfigSyncRules>}`;

export interface SynchSettingDefinitionsHost {
  app: App;
  controller: SynchSettingsController;
  showSelfHostedServerUrl: boolean | null;
  setShowSelfHostedServerUrl(value: boolean): void;
  requestRefresh(): void;
  setSyncRowControls(controls: SyncRowSettingControls | null): void;
  setStorageRowControls(controls: StorageRowSettingControls | null): void;
  setSyncDiagnosticsControls(controls: SyncDiagnosticsSettingControls | null): void;
}

/**
 * Declarative settings for Obsidian 1.13+.
 *
 * Each definition maps to exactly one setting row and its `render` callback
 * populates the row the framework provides. This keeps every row a direct,
 * framework-tracked child of the settings group, so Obsidian's own layout
 * rules (row dividers, group backgrounds) apply without plugin CSS. Content
 * must never be rendered outside the provided row: after each render pass
 * the framework resets the group's children to the tracked rows, discarding
 * anything else.
 *
 * Keep this cheap: it runs on tab registration (search indexing) and on every
 * update(). Heavy work stays inside render callbacks.
 */
export function buildSynchSettingDefinitions(
  host: SynchSettingDefinitionsHost,
): SettingDefinitionItem<SynchSettingControlKey>[] {
  const { controller } = host;
  const authReadiness = controller.getAuthReadiness();
  const hasAuthenticatedSession = controller.hasAuthenticatedSession();
  const hasConnectedRemoteVault = controller.hasConnectedRemoteVault();
  const isOfficialCloud =
    getServerDeployment(controller.getApiBaseUrl()) === "official_cloud";
  const isDeviceLoginInProgress = controller.isDeviceLoginInProgress();
  const serverCompatibility = controller.getServerCompatibilityStatus();
  const syncBlocked =
    serverCompatibility.state === "update_required" ||
    serverCompatibility.state === "incompatible";
  const requestRefresh = (): void => host.requestRefresh();

  // Kick off the update check here, not in the heading's render callback:
  // the heading is hidden until a check has succeeded, and the framework
  // does not guarantee render callbacks run for hidden rows. The check is
  // throttled and fire-and-forget, so this stays cheap; its completion
  // triggers refreshUi -> update(), which re-evaluates the badge.
  void controller.ensureCommunityPluginUpdateCheck();

  if (authReadiness.state === "pending_network") {
    return [
      headingDefinition(host),
      {
        name: t("network.required"),
        desc: t("network.requiredDesc"),
      },
    ];
  }

  const definitions: SettingDefinitionItem<SynchSettingControlKey>[] = [
    headingDefinition(host),
  ];

  if (!hasAuthenticatedSession) {
    const apiBaseUrlOptions: ApiBaseUrlSettingOptions = {
      canChangeApiBaseUrl: !isDeviceLoginInProgress && !hasConnectedRemoteVault,
      hasConnectedRemoteVault,
      isDeviceLoginInProgress,
      showSelfHostedServerUrl: host.showSelfHostedServerUrl ?? !isOfficialCloud,
      onShowSelfHostedServerUrlChange: (value) => {
        host.setShowSelfHostedServerUrl(value);
        host.requestRefresh();
      },
    };

    definitions.push({
      type: "group",
      heading: t("account"),
      items: [
        {
          name: t("authentication"),
          render: (setting) => {
            populateAuthenticationSetting(
              setting,
              controller,
              isDeviceLoginInProgress,
              requestRefresh,
            );
          },
        },
      ],
    });

    const serverItems: SettingDefinition<SynchSettingControlKey>[] = [
      {
        name: t("server.mode"),
        render: (setting) => {
          populateServerModeSetting(setting, controller, apiBaseUrlOptions);
        },
      },
    ];
    if (apiBaseUrlOptions.showSelfHostedServerUrl) {
      serverItems.push({
        name: t("server.url"),
        render: (setting) => {
          populateServerUrlSetting(setting, controller, apiBaseUrlOptions);
        },
      });
    }
    definitions.push({
      type: "group",
      heading: t("server.heading"),
      items: serverItems,
    });
    return definitions;
  }

  if (syncBlocked) {
    const compatibilityMessage = serverCompatibility.message;
    definitions.push({
      name: t("sync.paused"),
      render: (setting) => {
        populateSyncPausedSetting(setting, compatibilityMessage);
      },
    });
  } else if (!hasConnectedRemoteVault) {
    definitions.push({
      name: t("sync.label"),
      aliases: [t("vault.create"), t("vault.connect")],
      render: (setting) => {
        populateVaultConnectSetting(setting, controller, requestRefresh);
      },
    });
  } else {
    definitions.push({
      name: t("sync.label"),
      aliases: [t("sync.start"), t("sync.stop"), t("sync.now")],
      render: (setting) => {
        host.setSyncRowControls(populateSyncStatusSetting(setting, controller));
      },
    });
    definitions.push({
      name: t("storage.label"),
      render: (setting) => {
        host.setStorageRowControls(
          populateStorageStatusSetting(setting, controller),
        );
      },
    });
  }

  definitions.push({
    name: t("authentication"),
    render: (setting) => {
      populateAuthenticationSetting(
        setting,
        controller,
        isDeviceLoginInProgress,
        requestRefresh,
      );
    },
  });

  if (isOfficialCloud) {
    definitions.push({
      name: t("subscription.label"),
      render: (setting) => {
        void controller.ensureSubscriptionStatusCheck();
        populateSubscriptionSetting(setting, controller, requestRefresh);
      },
    });
  }

  definitions.push({
    name: t("vault.manage"),
    desc: t("vault.manageDesc"),
    render: (setting) => {
      populateVaultManageSetting(setting, controller);
    },
  });

  if (hasConnectedRemoteVault) {
    definitions.push({
      name: t("vault.setting"),
      aliases: [t("vault.disconnect")],
      render: (setting) => {
        populateVaultConnectionSetting(setting, controller, requestRefresh);
      },
    });
    definitions.push({
      name: t("deleted.header"),
      aliases: [t("vault.viewDeletedFiles")],
      render: (setting) => {
        populateDeletedFilesSetting(setting, host.app, controller, requestRefresh);
      },
    });
    if (controller.getRemoteVaultSyncFormatVersion() === 1) {
      definitions.push({
        name: t("vault.formatUpgradeTitle"),
        render: (setting) => {
          populateVaultFormatUpgradeSetting(setting, controller);
        },
      });
    }
  }

  definitions.push({
    type: "group",
    heading: t("fileSync.header"),
    items: buildFileSyncItems(host),
  });

  if (hasConnectedRemoteVault && !syncBlocked) {
    definitions.push({
      name: t("sync.frequency"),
      desc: t("sync.frequencyDesc"),
      control: {
        type: "dropdown",
        key: "syncIntervalMs",
        options: syncFrequencyOptions(),
      },
    });
  }

  definitions.push({
    name: t("diagnostics.header"),
    render: (setting) => {
      host.setSyncDiagnosticsControls(
        populateSyncDiagnosticsSetting(setting, host.app, controller),
      );
    },
  });

  return definitions;
}

export function getSynchSettingControlValue(
  controller: SynchSettingsController,
  key: string,
): unknown {
  if (key === "syncIntervalMs") {
    return String(controller.getSyncIntervalMs());
  }

  if (key.startsWith("fileRules.")) {
    const ruleKey = key.slice("fileRules.".length) as BooleanKeys<SynchFileRules>;
    return controller.getSyncFileRules()[ruleKey];
  }

  if (key.startsWith("vaultConfigSync.")) {
    const ruleKey = key.slice(
      "vaultConfigSync.".length,
    ) as BooleanKeys<SynchVaultConfigSyncRules>;
    return controller.getVaultConfigSyncRules()[ruleKey];
  }

  return undefined;
}

export async function setSynchSettingControlValue(
  controller: SynchSettingsController,
  key: string,
  value: unknown,
): Promise<void> {
  if (key === "syncIntervalMs") {
    await controller.setSyncIntervalMs(Number(value));
    return;
  }

  if (key.startsWith("fileRules.")) {
    const ruleKey = key.slice("fileRules.".length) as BooleanKeys<SynchFileRules>;
    await controller.updateSyncFileRule(ruleKey, value === true);
    return;
  }

  if (key.startsWith("vaultConfigSync.")) {
    const ruleKey = key.slice(
      "vaultConfigSync.".length,
    ) as BooleanKeys<SynchVaultConfigSyncRules>;
    await controller.updateVaultConfigSyncRule(ruleKey, value === true);
  }
}

function buildFileSyncItems(
  host: SynchSettingDefinitionsHost,
): SettingDefinition<SynchSettingControlKey>[] {
  const { controller } = host;
  const fileRules = controller.getSyncFileRules();
  const vaultConfigRules = controller.getVaultConfigSyncRules();
  const requestRefresh = (): void => host.requestRefresh();

  const items: SettingDefinition<SynchSettingControlKey>[] = [
    fileRuleToggle(t("images"), t("fileSync.imagesDesc"), "includeImages"),
    fileRuleToggle(t("audio"), t("fileSync.audioDesc"), "includeAudio"),
    fileRuleToggle(t("videos"), t("fileSync.videosDesc"), "includeVideos"),
    fileRuleToggle("PDF", t("fileSync.pdfDesc"), "includePdf"),
    fileRuleToggle(
      t("fileSync.other"),
      t("fileSync.otherDesc"),
      "includeOtherFiles",
    ),
    {
      name: t("excluded.header"),
      render: (setting) => {
        populateExcludedFoldersSetting(
          setting,
          host.app,
          controller,
          requestRefresh,
          fileRules,
        );
      },
    },
  ];

  for (const folder of fileRules.excludedFolders) {
    items.push({
      name: folder,
      searchable: false,
      render: (setting) => {
        populateExcludedFolderRow(setting, controller, requestRefresh, fileRules, folder);
      },
    });
  }

  items.push({
    name: t("hiddenFolders.header"),
    render: (setting) => {
      populateHiddenFoldersSetting(
        setting,
        host.app,
        controller,
        requestRefresh,
        fileRules,
      );
    },
  });

  for (const folder of fileRules.includedHiddenFolders) {
    items.push({
      name: folder,
      searchable: false,
      render: (setting) => {
        populateHiddenFolderRow(setting, controller, requestRefresh, fileRules, folder);
      },
    });
  }

  // Description-only hint row; the no-op render keeps the definition from
  // being filtered out (rows need a name, control, action, or render).
  items.push({
    name: "",
    desc: t("fileSync.hint"),
    searchable: false,
    render: () => {},
  });

  items.push({
    name: t("configSync.header"),
    desc: t("configSync.desc"),
    control: {
      type: "toggle",
      key: "vaultConfigSync.enabled",
    },
  });

  if (vaultConfigRules.enabled) {
    items.push(
      vaultConfigToggle(
        t("configSync.mainSettings"),
        t("configSync.mainSettingsDesc"),
        "mainSettings",
      ),
      vaultConfigToggle(
        t("configSync.appearance"),
        t("configSync.appearanceDesc"),
        "appearance",
      ),
      vaultConfigToggle(
        t("configSync.themesAndSnippets"),
        t("configSync.themesAndSnippetsDesc"),
        "themesAndSnippets",
      ),
      vaultConfigToggle(
        t("configSync.hotkeys"),
        t("configSync.hotkeysDesc"),
        "hotkeys",
      ),
      vaultConfigToggle(
        t("configSync.corePluginList"),
        t("configSync.corePluginListDesc"),
        "corePluginList",
      ),
      vaultConfigToggle(
        t("configSync.corePluginData"),
        t("configSync.corePluginDataDesc"),
        "corePluginData",
      ),
      vaultConfigToggle(
        t("configSync.communityPluginList"),
        t("configSync.communityPluginListDesc"),
        "communityPluginList",
      ),
      vaultConfigToggle(
        t("configSync.communityPluginFiles"),
        t("configSync.communityPluginFilesDesc"),
        "communityPluginFiles",
      ),
      vaultConfigToggle(
        t("configSync.communityPluginData"),
        t("configSync.communityPluginDataDesc"),
        "communityPluginData",
      ),
    );
  }

  return items;
}

function headingDefinition(
  host: SynchSettingDefinitionsHost,
): SettingDefinitionItem<SynchSettingControlKey> {
  return {
    name: "Synch",
    searchable: false,
    // The heading exists only to host the plugin-update badge; hide it
    // otherwise. The update check that can make the badge appear is kicked
    // off in buildSynchSettingDefinitions.
    visible: () => hasUpdateBadge(host.controller),
    render: (setting) => {
      populateSettingsHeading(setting, host.controller);
    },
  };
}

function fileRuleToggle(
  name: string,
  desc: string,
  key: BooleanKeys<SynchFileRules>,
): SettingDefinition<SynchSettingControlKey> {
  return {
    name,
    desc,
    control: {
      type: "toggle",
      key: `fileRules.${key}`,
    },
  };
}

function vaultConfigToggle(
  name: string,
  desc: string,
  key: BooleanKeys<SynchVaultConfigSyncRules>,
): SettingDefinition<SynchSettingControlKey> {
  return {
    name,
    desc,
    control: {
      type: "toggle",
      key: `vaultConfigSync.${key}`,
    },
  };
}

function syncFrequencyOptions(): Record<string, string> {
  return {
    "0": t("sync.frequencyRealtime"),
    "30000": t("sync.frequency30Seconds"),
    "60000": t("sync.frequency1Minute"),
    "180000": t("sync.frequency3Minutes"),
    "300000": t("sync.frequency5Minutes"),
    "600000": t("sync.frequency10Minutes"),
    "900000": t("sync.frequency15Minutes"),
    "1200000": t("sync.frequency20Minutes"),
    "1800000": t("sync.frequency30Minutes"),
  };
}
