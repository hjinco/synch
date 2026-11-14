import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  resetObsidianMocks,
  setRequestUrlMock,
} from "../test-stubs/obsidian";
import { DEFAULT_SYNC_FILE_RULES, DEFAULT_VAULT_CONFIG_SYNC_RULES } from "@synch/sync-client/core";

import { DEFAULT_SYNCH_PLUGIN_SETTINGS, type SynchPluginSettings } from "../settings/schema";
import { SynchPluginController } from "./plugin-controller";
import { createPluginWithSettings } from "./__tests__/readiness-helpers";

function createOfficialCloudSettings(): SynchPluginSettings {
  return {
    ...DEFAULT_SYNCH_PLUGIN_SETTINGS,
    apiBaseUrl: "https://api.synch.run",
    fileRules: DEFAULT_SYNC_FILE_RULES,
    vaultConfigSync: DEFAULT_VAULT_CONFIG_SYNC_RULES,
    syncEnabled: true,
    syncIntervalMs: 0,
  };
}

describe("SynchPluginController community plugin update check", () => {
  beforeEach(() => {
    resetObsidianMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("deduplicates in-flight update checks", async () => {
    const response = Promise.withResolvers<unknown>();
    const request = vi.fn(() => response.promise);
    const controller = new SynchPluginController({
      plugin: createPluginWithSettings(createOfficialCloudSettings()),
      refreshUi: vi.fn(),
    });
    await controller.initialize();
    setRequestUrlMock(request);

    const firstCheck = controller.ensureCommunityPluginUpdateCheck();
    const secondCheck = controller.ensureCommunityPluginUpdateCheck();

    expect(controller.getCommunityPluginUpdateStatus()).toEqual({
      state: "checking",
      currentVersion: "0.0.1",
    });
    expect(request).toHaveBeenCalledTimes(1);

    response.resolve({
      status: 200,
      text: '<guid isPermaLink="false">release:plugin:synch:0.0.2</guid>',
    });
    await Promise.all([firstCheck, secondCheck]);

    expect(request).toHaveBeenCalledTimes(1);
    expect(controller.getCommunityPluginUpdateStatus()).toEqual({
      state: "update_available",
      currentVersion: "0.0.1",
      latestVersion: "0.0.2",
    });
  });

  it("stores failed update checks for settings rendering", async () => {
    const request = vi.fn(async () => ({
      status: 200,
      text: "<rss></rss>",
    }));
    const controller = new SynchPluginController({
      plugin: createPluginWithSettings(createOfficialCloudSettings()),
      refreshUi: vi.fn(),
    });
    await controller.initialize();
    setRequestUrlMock(request);

    await controller.ensureCommunityPluginUpdateCheck();

    expect(controller.getCommunityPluginUpdateStatus()).toEqual({
      state: "failed",
      currentVersion: "0.0.1",
      error: expect.any(String),
    });
  });

  it("refreshes plugin update checks after five minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const request = vi.fn(async () => ({
      status: 200,
      text: '<guid isPermaLink="false">release:plugin:synch:0.0.1</guid>',
    }));
    const controller = new SynchPluginController({
      plugin: createPluginWithSettings(createOfficialCloudSettings()),
      refreshUi: vi.fn(),
    });
    await controller.initialize();
    setRequestUrlMock(request);

    await controller.ensureCommunityPluginUpdateCheck();
    await controller.ensureCommunityPluginUpdateCheck();

    expect(request).toHaveBeenCalledTimes(1);

    vi.setSystemTime(5 * 60 * 1000);
    await controller.ensureCommunityPluginUpdateCheck();

    expect(request).toHaveBeenCalledTimes(2);
  });

  it("skips community update checks for self-hosted servers", async () => {
    const request = vi.fn(async (input: unknown) => {
      const url = String((input as { url?: string }).url ?? "");
      if (url.includes("/v1/obsidian-plugin/version-check")) {
        return {
          status: 200,
          json: {
            status: "ok",
            minVersion: "0.0.9",
            apiMajor: 1,
          },
        };
      }

      throw new Error(`unexpected request ${url}`);
    });
    setRequestUrlMock(request);
    const controller = new SynchPluginController({
      plugin: createPluginWithSettings({
        apiBaseUrl: "https://custom.synch.test",
        fileRules: DEFAULT_SYNC_FILE_RULES,
        vaultConfigSync: DEFAULT_VAULT_CONFIG_SYNC_RULES,
        syncEnabled: true,
      }),
      refreshUi: vi.fn(),
    });
    await controller.initialize();
    expect(request).toHaveBeenCalledTimes(1);

    await controller.ensureCommunityPluginUpdateCheck();

    expect(request).toHaveBeenCalledTimes(1);
    expect(controller.getCommunityPluginUpdateStatus()).toEqual({
      state: "idle",
      currentVersion: "0.0.1",
    });
  });
});
