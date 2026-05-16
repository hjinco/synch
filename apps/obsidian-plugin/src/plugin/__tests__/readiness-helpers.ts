import type { Plugin } from "obsidian";
import { vi } from "vitest";

import { writeAuthSessionToken } from "../../auth/storage";
import { writeStoredRemoteVaultKeySecret } from "../../remote-vault/device-storage";
import { DEFAULT_SYNC_FILE_RULES } from "../../sync/core/file-rules";
import { DEFAULT_VAULT_CONFIG_SYNC_RULES } from "../../sync/core/vault-config-rules";
import type { SyncConnection } from "../../sync/store/store";
import { SYNCH_SETTINGS_KEY, type SynchPluginSettings } from "../../settings/schema";
import {
  Plugin as TestPluginClass,
  setRequestUrlMock,
} from "../../test-stubs/obsidian";

const TestPlugin = TestPluginClass as unknown as new () => Plugin;

export async function createConnectedPlugin(
  settingsOverrides: Partial<SynchPluginSettings> = {},
): Promise<Plugin & { savedData: Record<string, unknown> | null }> {
  const plugin = new TestPlugin() as Plugin & {
    savedData: Record<string, unknown> | null;
  };
  plugin.savedData = null;
  plugin.loadData = async () => ({
    [SYNCH_SETTINGS_KEY]: settings(settingsOverrides),
  });
  plugin.saveData = async (value: unknown) => {
    plugin.savedData = value as Record<string, unknown>;
  };
  await writeAuthSessionToken(plugin, "stored-token");
  await writeStoredRemoteVaultKeySecret(plugin, {
    remoteVaultKey: new Uint8Array(32).fill(1),
  });
  return plugin;
}

export function mockOnlineReadinessRequests(): void {
  setRequestUrlMock(
    vi.fn(async (input: unknown) => {
      const url = String((input as { url?: string }).url ?? "");
      if (url.endsWith("/api/auth/get-session")) {
        return {
          status: 200,
          json: {
            session: { id: "session-1" },
            user: {
              id: "user-1",
              email: "user@example.com",
              name: "User One",
            },
          },
        };
      }

      if (url.endsWith("/v1/vaults/vault-1/bootstrap")) {
        return {
          status: 200,
          json: {
            vault: {
              id: "vault-1",
              name: "Recovered",
              activeKeyVersion: 1,
              createdAt: "2026-04-22T00:00:00.000Z",
            },
            wrappers: [],
          },
        };
      }

      throw new Error(`unexpected request ${url}`);
    }),
  );
}

export function storedConnection(): SyncConnection {
  return {
    localVaultId: "local-vault-1",
    remoteVaultId: "vault-1",
    lastPulledCursor: 0,
  };
}

function settings(overrides: Partial<SynchPluginSettings>): SynchPluginSettings {
  return {
    apiBaseUrl: "http://127.0.0.1:8787",
    fileRules: DEFAULT_SYNC_FILE_RULES,
    vaultConfigSync: DEFAULT_VAULT_CONFIG_SYNC_RULES,
    syncEnabled: true,
    ...overrides,
  };
}
