import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  Plugin,
  resetObsidianMocks,
  setRequestUrlMock,
} from "../test-stubs/obsidian";
import { DEFAULT_SYNC_FILE_RULES } from "@synch/sync-client/sync/core/file-rules";
import { DEFAULT_VAULT_CONFIG_SYNC_RULES } from "@synch/sync-client/sync/core/vault-config-rules";
import { SYNCH_SETTINGS_KEY, type SynchPluginSettings } from "../settings/schema";
import { SynchPluginController } from "./plugin-controller";

const TestPlugin = Plugin as unknown as new () => Plugin;

function createPluginWithSettings(settings: SynchPluginSettings): Plugin & {
  savedData: Record<string, unknown> | null;
} {
  const plugin = new TestPlugin() as Plugin & {
    savedData: Record<string, unknown> | null;
  };
  plugin.savedData = null;
  plugin.loadData = async () => ({
    [SYNCH_SETTINGS_KEY]: settings,
  });
  plugin.saveData = async (value: unknown) => {
    plugin.savedData = value as Record<string, unknown>;
  };
  return plugin;
}

describe("SynchPluginController community plugin update check", () => {
  beforeEach(() => {
    resetObsidianMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("deduplicates in-flight update checks", async () => {
    let resolveRequest: ((value: unknown) => void) | null = null;
    const request = vi.fn(
      async () =>
        await new Promise((resolve) => {
          resolveRequest = resolve;
        }),
    );
    setRequestUrlMock(request);

    const controller = new SynchPluginController({
      plugin: new TestPlugin(),
      refreshUi: vi.fn(),
    });

    const firstCheck = controller.ensureCommunityPluginUpdateCheck();
    const secondCheck = controller.ensureCommunityPluginUpdateCheck();

    expect(controller.getCommunityPluginUpdateStatus()).toEqual({
      state: "checking",
      currentVersion: "0.0.1",
    });
    expect(request).toHaveBeenCalledTimes(1);

    resolveRequest?.({
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
    setRequestUrlMock(
      vi.fn(async () => ({
        status: 200,
        text: "<rss></rss>",
      })),
    );
    const controller = new SynchPluginController({
      plugin: new TestPlugin(),
      refreshUi: vi.fn(),
    });

    await controller.ensureCommunityPluginUpdateCheck();

    expect(controller.getCommunityPluginUpdateStatus()).toEqual({
      state: "failed",
      currentVersion: "0.0.1",
      error: "Community plugin release feed does not contain a version.",
    });
  });

  it("refreshes plugin update checks after five minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const request = vi.fn(async () => ({
      status: 200,
      text: '<guid isPermaLink="false">release:plugin:synch:0.0.1</guid>',
    }));
    setRequestUrlMock(request);
    const controller = new SynchPluginController({
      plugin: new TestPlugin(),
      refreshUi: vi.fn(),
    });

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
