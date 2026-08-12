import type {
  Setting as ObsidianSetting,
  SettingGroup,
} from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDefaultApiBaseUrl } from "../../config";
import { t } from "../../i18n";
import {
  getButtonComponents,
  getNotices,
  getProgressBarComponents,
  getSettingDescriptions,
  getSettingNames,
  getTextComponents,
  getToggleComponents,
  resetObsidianMocks,
  Setting,
} from "../../test-stubs/obsidian";
import type { AppWithSettings } from "../contracts";
import { createSettingsTab } from "./__tests__/settings-tab-helpers";

describe("SynchSettingTab", () => {
  beforeEach(() => {
    resetObsidianMocks();
  });

  it("offers to reopen or cancel the sign-in page while device login is in progress", async () => {
    let isDeviceLoginInProgress = true;
    const cancelDeviceLogin = vi.fn(() => {
      isDeviceLoginInProgress = false;
    });
    const tab = createSettingsTab({
      isDeviceLoginInProgress: () => isDeviceLoginInProgress,
      cancelDeviceLogin,
    });

    tab.open();

    expect(getButtonComponents().map((button) => button.text)).toEqual([
      t("auth.openSignInAgain"),
      t("cancel"),
    ]);

    await getButtonComponents()[1]?.click();

    expect(cancelDeviceLogin).toHaveBeenCalledTimes(1);
    expect(getButtonComponents().at(-1)?.text).toBe(t("auth.signInOnThisDevice"));
  });

  it("shows the normal sign-in button when device login is idle", () => {
    const tab = createSettingsTab({
      isDeviceLoginInProgress: () => false,
    });

    tab.open();

    const signInButton = getButtonComponents()[0];
    expect(signInButton?.text).toBe(t("auth.signInOnThisDevice"));
    expect(signInButton?.disabled).toBe(false);
    expect(getButtonComponents().map((button) => button.text)).not.toContain(
      t("cancel"),
    );
  });

  it("shows account before server settings before sign-in", () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => false,
    });

    tab.open();

    const buttonTexts = getButtonComponents().map((button) => button.text);
    expect(getSettingNames().slice(0, 4)).toEqual([
      t("account"),
      t("authentication"),
      t("server.heading"),
      t("server.mode"),
    ]);
    expect(buttonTexts).toEqual([t("auth.signInOnThisDevice")]);
    expect(getToggleComponents()[0]?.value).toBe(false);
    expect(getProgressBarComponents()).toEqual([]);
  });

  it("only asks for network connection when stored sign-in needs online verification", () => {
    const tab = createSettingsTab({
      getAuthReadiness: () => ({
        state: "pending_network",
        token: "stored-token",
      }),
      getAuthStatusLabel: () => t("network.requiredDesc"),
      hasAuthenticatedSession: () => false,
    });

    tab.open();

    expect(getSettingNames()).toEqual([t("network.required")]);
    expect(getSettingDescriptions()).toContain(t("network.requiredDesc"));
    expect(getButtonComponents()).toEqual([]);
    expect(getTextComponents()).toEqual([]);
  });

  it("shows a first-row update notice that opens Community plugins when an update is available", async () => {
    const ensureCommunityPluginUpdateCheck = vi.fn(async () => {});
    const tab = createSettingsTab({
      ensureCommunityPluginUpdateCheck,
      getCommunityPluginUpdateStatus: () => ({
        state: "update_available",
        currentVersion: "0.0.1",
        latestVersion: "0.0.2",
      }),
    });
    const openedSettingTabs: string[] = [];
    (tab.app as AppWithSettings).setting = {
      open: () => {},
      openTabById: (id) => {
        openedSettingTabs.push(id);
      },
    };

    tab.open();

    expect(ensureCommunityPluginUpdateCheck).toHaveBeenCalledTimes(1);
    expect(getSettingNames()[0]).toBe(t("plugin.updateAvailable"));
    expect(getSettingDescriptions()).toContain(
      t("plugin.updateAvailableDesc", { version: "0.0.2" }),
    );

    const updateButton = getButtonComponents()[0];
    expect(updateButton?.text).toBe(t("plugin.openCommunityPlugins"));
    await updateButton?.click();
    expect(openedSettingTabs).toEqual(["community-plugins"]);
  });

  it("shows required plugin updates as a sync blocker", () => {
    const tab = createSettingsTab({
      getServerCompatibilityStatus: () => ({
        state: "update_required",
        currentVersion: "0.0.1",
        minVersion: "1.2.0",
        message: "Update Synch before syncing.",
      }),
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
    });

    tab.open();

    expect(getSettingNames()).toContain(t("plugin.updateRequired"));
    expect(getSettingNames()).toContain(t("sync.paused"));
    expect(getSettingDescriptions()).toContain("Update Synch before syncing.");
    expect(getButtonComponents().map((button) => button.text)).toContain(
      t("plugin.openCommunityPlugins"),
    );
    expect(getButtonComponents().map((button) => button.text)).not.toContain(t("sync.start"));
  });

  it("hides plugin update status from settings when no update is available", () => {
    const tab = createSettingsTab({
      getCommunityPluginUpdateStatus: () => ({
        state: "checking",
        currentVersion: "0.0.1",
      }),
    });

    tab.open();

    expect(getSettingNames()).not.toContain(t("plugin.updateAvailable"));

    resetObsidianMocks();
    createSettingsTab({
      getCommunityPluginUpdateStatus: () => ({
        state: "up_to_date",
        currentVersion: "0.0.1",
        latestVersion: "0.0.1",
      }),
    }).open();

    expect(getSettingNames()).not.toContain(t("plugin.updateAvailable"));

    resetObsidianMocks();
    createSettingsTab({
      getCommunityPluginUpdateStatus: () => ({
        state: "failed",
        currentVersion: "0.0.1",
        error: "offline",
      }),
    }).open();

    expect(getSettingNames()).not.toContain(t("plugin.updateAvailable"));
    expect(getButtonComponents()[0]?.text).toBe(t("auth.signInOnThisDevice"));
  });

  // The update row does not exist until a check has succeeded, so the check
  // must not depend on that row being rendered.
  it("kicks off the plugin update check while the update row is absent", () => {
    const ensureCommunityPluginUpdateCheck = vi.fn(async () => {});
    const tab = createSettingsTab({
      ensureCommunityPluginUpdateCheck,
      getCommunityPluginUpdateStatus: () => ({
        state: "idle",
        currentVersion: "0.0.1",
      }),
    });

    tab.open();

    expect(getSettingNames()).not.toContain(t("plugin.updateAvailable"));
    expect(ensureCommunityPluginUpdateCheck).toHaveBeenCalledTimes(1);
  });

  it("shows an editable self-hosted server URL before sign-in when already configured", async () => {
    const updateApiBaseUrl = vi.fn(async () => {});
    const tab = createSettingsTab({
      getApiBaseUrl: () => "https://api.synch.test",
      updateApiBaseUrl,
    });

    tab.open();

    expect(getToggleComponents()[0]?.value).toBe(true);
    const apiBaseUrlInput = getTextComponents()[0];
    expect(apiBaseUrlInput?.value).toBe("https://api.synch.test");
    expect(apiBaseUrlInput?.disabled).toBe(false);

    const saveButton = getButtonComponents()[1];
    expect(saveButton?.text).toBe(t("save"));
    expect(saveButton?.disabled).toBe(false);

    await apiBaseUrlInput?.change("https://custom.synch.test");
    expect(updateApiBaseUrl).not.toHaveBeenCalled();

    await saveButton?.click();
    expect(updateApiBaseUrl).toHaveBeenCalledWith("https://custom.synch.test");
    expect(getNotices()).toContainEqual({ message: t("server.saved") });
  });

  it("does not show the self-hosted server URL saved notice when saving fails", async () => {
    const updateApiBaseUrl = vi.fn(async () => {
      throw new Error("API base URL must be a valid http:// or https:// URL.");
    });
    const tab = createSettingsTab({
      getApiBaseUrl: () => "https://api.synch.test",
      updateApiBaseUrl,
    });

    tab.open();

    await getTextComponents()[0]?.change("not-a-url");
    await getButtonComponents()[1]?.click();

    expect(getNotices()).toEqual([
      {
        message: t("server.saveFailed", {
          message: "API base URL must be a valid http:// or https:// URL.",
        }),
        timeout: undefined,
      },
    ]);
    expect(getNotices()[0]?.message).toContain(
      "API base URL must be a valid http:// or https:// URL.",
    );
  });

  it("does not show the default API base URL before sign-in", async () => {
    const updateApiBaseUrl = vi.fn(async () => {});
    const tab = createSettingsTab({
      getApiBaseUrl: () => getDefaultApiBaseUrl(),
      updateApiBaseUrl,
    });

    tab.open();

    expect(getToggleComponents()[0]?.value).toBe(false);
    expect(getTextComponents()).toEqual([]);
    expect(getButtonComponents().map((button) => button.text)).not.toContain(t("save"));
    expect(updateApiBaseUrl).not.toHaveBeenCalled();
  });

  it("hides the self-hosted server URL after sign-in", () => {
    const updateApiBaseUrl = vi.fn(async () => {});
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      getApiBaseUrl: () => "https://api.synch.test",
      updateApiBaseUrl,
    });

    tab.open();

    expect(getSettingNames()).not.toContain(t("server.url"));
    expect(getTextComponents()).toEqual([]);
    expect(getButtonComponents().map((button) => button.text)).not.toContain(t("save"));
    expect(updateApiBaseUrl).not.toHaveBeenCalled();
  });

  it("shows subscription status after sign-in", () => {
    const ensureSubscriptionStatusCheck = vi.fn(async () => {});
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      ensureSubscriptionStatusCheck,
    });

    tab.open();

    expect(ensureSubscriptionStatusCheck).toHaveBeenCalledTimes(1);
    expect(getSettingNames()).toContain(t("subscription.label"));
    expect(getSettingDescriptions()).toContain(t("subscription.checking"));
  });

  it("hides subscription settings for custom API servers", () => {
    const ensureSubscriptionStatusCheck = vi.fn(async () => {});
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      getApiBaseUrl: () => "https://custom.synch.test",
      ensureSubscriptionStatusCheck,
    });

    tab.open();

    expect(ensureSubscriptionStatusCheck).not.toHaveBeenCalled();
    expect(getSettingNames()).not.toContain(t("subscription.label"));
    expect(getSettingDescriptions()).not.toContain(t("subscription.checking"));
  });

  it("opens pricing from free subscription settings", async () => {
    const openPricingPage = vi.fn();
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      getSubscriptionStatus: () => ({
        state: "loaded",
        planId: "free",
        billingInterval: null,
        active: false,
        status: "none",
        cancelAtPeriodEnd: false,
        periodEnd: null,
      }),
      openPricingPage,
    });

    tab.open();

    expect(getSettingDescriptions()).toContain(t("subscription.freePlan"));
    const upgradeButton = getButtonComponents().find(
      (button) => button.text === t("subscription.upgrade"),
    );
    await upgradeButton?.click();

    expect(openPricingPage).toHaveBeenCalledTimes(1);
  });

  it("opens billing management from paid subscription settings", async () => {
    const openBillingManagementPage = vi.fn();
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      getSubscriptionStatus: () => ({
        state: "loaded",
        planId: "starter",
        billingInterval: "annual",
        active: true,
        status: "active",
        cancelAtPeriodEnd: false,
        periodEnd: "2026-05-09T00:00:00.000Z",
      }),
      openBillingManagementPage,
    });

    tab.open();

    expect(getSettingDescriptions()).toContain(t("subscription.starterPlan"));
    const manageButton = getButtonComponents().find(
      (button) => button.text === t("subscription.manage"),
    );
    await manageButton?.click();

    expect(openBillingManagementPage).toHaveBeenCalledTimes(1);
  });

  it("shows canceling paid subscription period end", () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      getSubscriptionStatus: () => ({
        state: "loaded",
        planId: "starter",
        billingInterval: "monthly",
        active: true,
        status: "active",
        cancelAtPeriodEnd: true,
        periodEnd: "2026-05-09T00:00:00.000Z",
      }),
    });

    tab.open();

    expect(getSettingDescriptions()).toContain(
      t("subscription.canceling", {
        plan: t("subscription.starterPlan"),
        periodEnd: "May 9, 2026",
      }),
    );
  });

  it("can retry failed subscription status checks", async () => {
    const retrySubscriptionStatusCheck = vi.fn(async () => {});
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      getSubscriptionStatus: () => ({
        state: "failed",
        error: "offline",
      }),
      retrySubscriptionStatusCheck,
    });

    tab.open();

    expect(getSettingDescriptions()).toContain(t("subscription.failed"));
    const refreshButton = getButtonComponents().find(
      (button) => button.text === t("refresh"),
    );
    await refreshButton?.click();

    expect(retrySubscriptionStatusCheck).toHaveBeenCalledTimes(1);
  });

  it("disables the self-hosted server URL during device sign-in", async () => {
    const updateApiBaseUrl = vi.fn(async () => {});
    const tab = createSettingsTab({
      isDeviceLoginInProgress: () => true,
      getApiBaseUrl: () => "https://api.synch.test",
      updateApiBaseUrl,
    });

    tab.open();

    expect(getToggleComponents()[0]?.disabled).toBe(true);
    const apiBaseUrlInput = getTextComponents()[0];
    const saveButton = getButtonComponents().find((button) => button.text === t("save"));
    expect(apiBaseUrlInput?.disabled).toBe(true);
    expect(saveButton?.disabled).toBe(true);

    await apiBaseUrlInput?.change("https://custom.synch.test");
    await saveButton?.click();

    expect(updateApiBaseUrl).not.toHaveBeenCalled();
  });

  it("disables the self-hosted server URL while a vault is connected", async () => {
    const updateApiBaseUrl = vi.fn(async () => {});
    const tab = createSettingsTab({
      hasConnectedRemoteVault: () => true,
      getApiBaseUrl: () => "https://api.synch.test",
      updateApiBaseUrl,
    });

    tab.open();

    expect(getToggleComponents()[0]?.disabled).toBe(true);
    const apiBaseUrlInput = getTextComponents()[0];
    const saveButton = getButtonComponents()[1];
    expect(apiBaseUrlInput?.disabled).toBe(true);
    expect(saveButton?.disabled).toBe(true);
    expect(getSettingDescriptions()[1]).toBe(t("server.descDisconnectVault"));

    await apiBaseUrlInput?.change("https://custom.synch.test");
    await saveButton?.click();

    expect(updateApiBaseUrl).not.toHaveBeenCalled();
  });

  it("hides the sign-in button and shows sign out when already signed in", () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      isDeviceLoginInProgress: () => false,
    });

    tab.open();

    const buttonTexts = getButtonComponents().map((button) => button.text);
    expect(buttonTexts).not.toContain(t("auth.signInOnThisDevice"));
    expect(buttonTexts).not.toContain(t("auth.openSignInAgain"));
    expect(buttonTexts).not.toContain(t("cancel"));
    expect(buttonTexts).toContain(t("auth.signOut"));
  });

  it("hides sign out before sign-in", () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => false,
    });

    tab.open();

    const buttonTexts = getButtonComponents().map((button) => button.text);
    expect(buttonTexts).toContain(t("auth.signInOnThisDevice"));
    expect(buttonTexts).not.toContain(t("auth.signOut"));
  });

  it("does not own remote storage usage watching while visible", () => {
    const watchStorageStatus = vi.fn();
    const unwatchStorageStatus = vi.fn();
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
      watchStorageStatus,
      unwatchStorageStatus,
    });

    tab.open();
    tab.open();
    tab.hide();

    expect(watchStorageStatus).not.toHaveBeenCalled();
    expect(unwatchStorageStatus).not.toHaveBeenCalled();
  });

  it("does not watch remote storage usage when a hidden settings tab refreshes", () => {
    const watchStorageStatus = vi.fn();
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
      watchStorageStatus,
    });

    tab.refresh();

    expect(watchStorageStatus).toHaveBeenCalledTimes(0);
  });

  it("does not watch remote storage usage without a connected vault", () => {
    const watchStorageStatus = vi.fn();
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => false,
      watchStorageStatus,
    });

    tab.open();

    expect(watchStorageStatus).toHaveBeenCalledTimes(0);
  });

  // Obsidian's declarative settings renderer only keeps the DOM nodes it
  // tracks: after each render pass the group's children are reset to the
  // definitions' settingEls, so content rendered outside the provided row
  // (e.g. into group.listEl) is silently discarded and a removed row is
  // re-attached empty.
  it("keeps declarative render output inside the tracked setting row", () => {
    const scenarios = [
      {},
      { hasAuthenticatedSession: () => true, hasConnectedRemoteVault: () => true },
      {
        getAuthReadiness: () => ({
          state: "pending_network" as const,
          token: "stored-token",
        }),
        // The network-required row has no render callback; an available
        // update keeps this scenario exercising a rendered row.
        getCommunityPluginUpdateStatus: () => ({
          state: "update_available" as const,
          currentVersion: "0.0.1",
          latestVersion: "0.0.2",
        }),
      },
    ];

    for (const overrides of scenarios) {
      const tab = createSettingsTab(overrides);
      const renderDefinitions = collectRenderDefinitions(tab.getSettingDefinitions());
      expect(renderDefinitions.length).toBeGreaterThan(0);

      for (const definition of renderDefinitions) {
        const setting = new Setting(null);
        let usedGroupListEl = false;
        const group = {
          get listEl(): unknown {
            usedGroupListEl = true;
            return undefined;
          },
        };

        definition.render(
          setting as unknown as ObsidianSetting,
          group as unknown as SettingGroup,
        );

        expect(setting.settingEl.detached).toBe(false);
        expect(usedGroupListEl).toBe(false);
      }
    }
  });

  it("exposes declarative setting definitions for Obsidian settings search", () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      hasConnectedRemoteVault: () => true,
    });

    const definitions = tab.getSettingDefinitions();
    const names = collectSettingNames(definitions);

    expect(definitions.length).toBeGreaterThan(0);
    expect(names).toEqual(
      expect.arrayContaining([
        t("sync.label"),
        t("authentication"),
        t("images"),
        t("sync.frequency"),
        t("diagnostics.header"),
      ]),
    );
  });

});

interface RenderDefinition {
  render: (setting: ObsidianSetting, group: SettingGroup) => unknown;
}

function collectRenderDefinitions(definitions: unknown[]): RenderDefinition[] {
  const found: RenderDefinition[] = [];
  for (const definition of definitions) {
    if (!definition || typeof definition !== "object") {
      continue;
    }
    const record = definition as { render?: unknown; items?: unknown[] };
    if (typeof record.render === "function") {
      found.push(record as RenderDefinition);
    }
    if (Array.isArray(record.items)) {
      found.push(...collectRenderDefinitions(record.items));
    }
  }
  return found;
}

function collectSettingNames(definitions: unknown[]): string[] {
  const names: string[] = [];
  for (const definition of definitions) {
    if (!definition || typeof definition !== "object") {
      continue;
    }
    const record = definition as {
      name?: unknown;
      heading?: unknown;
      items?: unknown[];
    };
    if (typeof record.name === "string") {
      names.push(record.name);
    }
    if (typeof record.heading === "string") {
      names.push(record.heading);
    }
    if (Array.isArray(record.items)) {
      names.push(...collectSettingNames(record.items));
    }
  }
  return names;
}
