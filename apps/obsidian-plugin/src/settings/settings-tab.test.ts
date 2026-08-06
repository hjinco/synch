import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDefaultApiBaseUrl } from "../config";
import {
  getButtonComponents,
  getCreatedElements,
  getCreatedElementTexts,
  getNotices,
  getProgressBarComponents,
  getSettingClasses,
  getSettingDescriptions,
  getSettingNames,
  getTextComponents,
  getToggleComponents,
  resetObsidianMocks,
} from "../test-stubs/obsidian";
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

    tab.display();

    expect(getButtonComponents().map((button) => button.text)).toEqual([
      "Open sign-in page again",
      "Cancel",
    ]);

    await getButtonComponents()[1]?.click();

    expect(cancelDeviceLogin).toHaveBeenCalledTimes(1);
    expect(getButtonComponents().at(-1)?.text).toBe("Sign in on this device");
  });

  it("shows the normal sign-in button when device login is idle", () => {
    const tab = createSettingsTab({
      isDeviceLoginInProgress: () => false,
    });

    tab.display();

    const signInButton = getButtonComponents()[0];
    expect(signInButton?.text).toBe("Sign in on this device");
    expect(signInButton?.disabled).toBe(false);
    expect(getButtonComponents().map((button) => button.text)).not.toContain(
      "Cancel",
    );
  });

  it("shows account before server settings before sign-in", () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => false,
    });

    tab.display();

    const buttonTexts = getButtonComponents().map((button) => button.text);
    expect(getSettingNames().slice(0, 5)).toEqual([
      "Synch",
      "Account",
      "Authentication",
      "Server",
      "Use a self-hosted server",
    ]);
    expect(buttonTexts).toEqual(["Sign in on this device"]);
    expect(getToggleComponents()[0]?.value).toBe(false);
    expect(getProgressBarComponents()).toEqual([]);
  });

  it("only asks for network connection when stored sign-in needs online verification", () => {
    const tab = createSettingsTab({
      getAuthReadiness: () => ({
        state: "pending_network",
        token: "stored-token",
      }),
      getAuthStatusLabel: () => "Connect to the internet to check sign-in.",
      hasAuthenticatedSession: () => false,
    });

    tab.display();

    expect(getSettingNames()).toEqual(["Synch", "Network connection required"]);
    expect(getSettingDescriptions()).toContain(
      "Connect to the internet to check sign-in.",
    );
    expect(getButtonComponents()).toEqual([]);
    expect(getTextComponents()).toEqual([]);
  });

  it("checks and shows plugin updates on the right side of the settings heading only when needed", () => {
    const ensureCommunityPluginUpdateCheck = vi.fn(async () => {});
    const tab = createSettingsTab({
      ensureCommunityPluginUpdateCheck,
      getCommunityPluginUpdateStatus: () => ({
        state: "update_available",
        currentVersion: "0.0.1",
        latestVersion: "0.0.2",
      }),
    });

    tab.display();

    expect(ensureCommunityPluginUpdateCheck).toHaveBeenCalledTimes(1);
    expect(getSettingNames()[0]).toBe("Synch");
    expect(getCreatedElementTexts()).toContain("Update Synch from Community plugins");
    expect(getSettingDescriptions()).not.toContain(
      "Version 0.0.2 is available. Current version: 0.0.1.",
    );
    expect(getCreatedElements()).toContainEqual({
      tag: "span",
      text: "Update Synch from Community plugins",
      classes: ["synch-plugin-update-badge"],
      attributes: {},
    });
    expect(getSettingClasses()[0]).toContain("synch-plugin-update-available");
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

    tab.display();

    expect(getCreatedElementTexts()).toContain("Update required");
    expect(getSettingNames()).toContain("Sync paused");
    expect(getSettingDescriptions()).toContain("Update Synch before syncing.");
    expect(getButtonComponents().map((button) => button.text)).not.toContain("Start sync");
  });

  it("hides plugin update status from settings when no update is available", () => {
    const tab = createSettingsTab({
      getCommunityPluginUpdateStatus: () => ({
        state: "checking",
        currentVersion: "0.0.1",
      }),
    });

    tab.display();

    expect(getSettingNames()).not.toContain("Plugin update");
    expect(getCreatedElementTexts()).not.toContain("Update Synch from Community plugins");

    resetObsidianMocks();
    createSettingsTab({
      getCommunityPluginUpdateStatus: () => ({
        state: "up_to_date",
        currentVersion: "0.0.1",
        latestVersion: "0.0.1",
      }),
    }).display();

    expect(getSettingNames()).not.toContain("Plugin update");
    expect(getSettingClasses()[0]).not.toContain("synch-plugin-update-available");

    resetObsidianMocks();
    createSettingsTab({
      getCommunityPluginUpdateStatus: () => ({
        state: "failed",
        currentVersion: "0.0.1",
        error: "offline",
      }),
    }).display();

    expect(getSettingNames()).not.toContain("Plugin update");
    expect(getButtonComponents()[0]?.text).toBe("Sign in on this device");
  });

  it("shows an editable self-hosted server URL before sign-in when already configured", async () => {
    const updateApiBaseUrl = vi.fn(async () => {});
    const tab = createSettingsTab({
      getApiBaseUrl: () => "https://api.synch.test",
      updateApiBaseUrl,
    });

    tab.display();

    expect(getToggleComponents()[0]?.value).toBe(true);
    const apiBaseUrlInput = getTextComponents()[0];
    expect(apiBaseUrlInput?.value).toBe("https://api.synch.test");
    expect(apiBaseUrlInput?.disabled).toBe(false);

    const saveButton = getButtonComponents()[1];
    expect(saveButton?.text).toBe("Save");
    expect(saveButton?.disabled).toBe(false);

    await apiBaseUrlInput?.change("https://custom.synch.test");
    expect(updateApiBaseUrl).not.toHaveBeenCalled();

    await saveButton?.click();
    expect(updateApiBaseUrl).toHaveBeenCalledWith("https://custom.synch.test");
    expect(getNotices()).toContainEqual({ message: "Server URL saved." });
  });

  it("does not show the self-hosted server URL saved notice when saving fails", async () => {
    const updateApiBaseUrl = vi.fn(async () => {
      throw new Error("API base URL must be a valid http:// or https:// URL.");
    });
    const tab = createSettingsTab({
      getApiBaseUrl: () => "https://api.synch.test",
      updateApiBaseUrl,
    });

    tab.display();

    await getTextComponents()[0]?.change("not-a-url");
    await getButtonComponents()[1]?.click();

    expect(getNotices()).toEqual([
      {
        message:
          "Server settings could not be saved: API base URL must be a valid http:// or https:// URL.",
        timeout: undefined,
      },
    ]);
  });

  it("does not show the default API base URL before sign-in", async () => {
    const updateApiBaseUrl = vi.fn(async () => {});
    const tab = createSettingsTab({
      getApiBaseUrl: () => getDefaultApiBaseUrl(),
      updateApiBaseUrl,
    });

    tab.display();

    expect(getToggleComponents()[0]?.value).toBe(false);
    expect(getTextComponents()).toEqual([]);
    expect(getButtonComponents().map((button) => button.text)).not.toContain("Save");
    expect(updateApiBaseUrl).not.toHaveBeenCalled();
  });

  it("hides the self-hosted server URL after sign-in", () => {
    const updateApiBaseUrl = vi.fn(async () => {});
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      getApiBaseUrl: () => "https://api.synch.test",
      updateApiBaseUrl,
    });

    tab.display();

    expect(getSettingNames()).not.toContain("Self-hosted server URL");
    expect(getTextComponents()).toEqual([]);
    expect(getButtonComponents().map((button) => button.text)).not.toContain("Save");
    expect(updateApiBaseUrl).not.toHaveBeenCalled();
  });

  it("shows subscription status after sign-in", () => {
    const ensureSubscriptionStatusCheck = vi.fn(async () => {});
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      ensureSubscriptionStatusCheck,
    });

    tab.display();

    expect(ensureSubscriptionStatusCheck).toHaveBeenCalledTimes(1);
    expect(getSettingNames()).toContain("Subscription");
    expect(getSettingDescriptions()).toContain("Checking subscription...");
  });

  it("hides subscription settings for custom API servers", () => {
    const ensureSubscriptionStatusCheck = vi.fn(async () => {});
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      getApiBaseUrl: () => "https://custom.synch.test",
      ensureSubscriptionStatusCheck,
    });

    tab.display();

    expect(ensureSubscriptionStatusCheck).not.toHaveBeenCalled();
    expect(getSettingNames()).not.toContain("Subscription");
    expect(getSettingDescriptions()).not.toContain("Checking subscription...");
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

    tab.display();

    expect(getSettingDescriptions()).toContain("Sync Free");
    const upgradeButton = getButtonComponents().find((button) => button.text === "Upgrade");
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

    tab.display();

    expect(getSettingDescriptions()).toContain("Sync Starter");
    const manageButton = getButtonComponents().find(
      (button) => button.text === "Manage subscription",
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

    tab.display();

    expect(getSettingDescriptions()).toContain("Sync Starter. Current period ends May 9, 2026.");
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

    tab.display();

    expect(getSettingDescriptions()).toContain(
      "Subscription status could not be loaded.",
    );
    const refreshButton = getButtonComponents().find((button) => button.text === "Refresh");
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

    tab.display();

    expect(getToggleComponents()[0]?.disabled).toBe(true);
    const apiBaseUrlInput = getTextComponents()[0];
    const saveButton = getButtonComponents().find((button) => button.text === "Save");
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

    tab.display();

    expect(getToggleComponents()[0]?.disabled).toBe(true);
    const apiBaseUrlInput = getTextComponents()[0];
    const saveButton = getButtonComponents()[1];
    expect(apiBaseUrlInput?.disabled).toBe(true);
    expect(saveButton?.disabled).toBe(true);
    expect(getSettingDescriptions()[1]).toBe(
      "Disconnect the current vault before changing servers.",
    );

    await apiBaseUrlInput?.change("https://custom.synch.test");
    await saveButton?.click();

    expect(updateApiBaseUrl).not.toHaveBeenCalled();
  });

  it("hides the sign-in button and shows sign out when already signed in", () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => true,
      isDeviceLoginInProgress: () => false,
    });

    tab.display();

    const buttonTexts = getButtonComponents().map((button) => button.text);
    expect(buttonTexts).not.toContain("Sign in on this device");
    expect(buttonTexts).not.toContain("Open sign-in page again");
    expect(buttonTexts).not.toContain("Cancel");
    expect(buttonTexts).toContain("Sign out");
  });

  it("hides sign out before sign-in", () => {
    const tab = createSettingsTab({
      hasAuthenticatedSession: () => false,
    });

    tab.display();

    const buttonTexts = getButtonComponents().map((button) => button.text);
    expect(buttonTexts).toContain("Sign in on this device");
    expect(buttonTexts).not.toContain("Sign out");
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

    tab.display();
    tab.display();
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

    tab.display();

    expect(watchStorageStatus).toHaveBeenCalledTimes(0);
  });

});
