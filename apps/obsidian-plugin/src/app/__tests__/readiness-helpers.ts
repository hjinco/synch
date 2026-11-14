import type { Plugin } from "obsidian";
import { vi } from "vitest";

import { encodeBase64 } from "@synch/vault-crypto";
import { ObsidianAuthSessionTokenStore } from "../../adapters/auth-session-storage";
import { writeStoredRemoteVaultKeySecret } from "../../adapters/remote-vault-device-storage";
import type { SyncConnection } from "@synch/sync-client/store";
import { DEFAULT_SYNCH_PLUGIN_SETTINGS, SYNCH_SETTINGS_KEY, type SynchPluginSettings } from "../../settings/schema";
import {
  createMockPlugin,
  setRequestUrlMock,
} from "../../test-stubs/obsidian";

export function createPluginWithSettings(
  settingsOverrides: Partial<SynchPluginSettings> = {},
): Plugin & { savedData: Record<string, unknown> | null } {
  const plugin = Object.assign(createMockPlugin(), {
    savedData: null as Record<string, unknown> | null,
  });
  const initial = {
    [SYNCH_SETTINGS_KEY]: {
      ...DEFAULT_SYNCH_PLUGIN_SETTINGS,
      apiBaseUrl: "http://127.0.0.1:8787",
      ...settingsOverrides,
    },
  };
  plugin.loadData = async () => plugin.savedData ?? initial;
  plugin.saveData = async (value: unknown) => {
    plugin.savedData = value as Record<string, unknown>;
  };
  return plugin;
}

export async function createConnectedPlugin(
  settingsOverrides: Partial<SynchPluginSettings> = {},
  options: { legacySecrets?: boolean } = {},
): Promise<Plugin & { savedData: Record<string, unknown> | null }> {
  const plugin = createPluginWithSettings(settingsOverrides);
  const remoteVaultKey = new Uint8Array(32).fill(1);
  if (options.legacySecrets) {
    plugin.app.secretStorage.setSecret("synch-session-token", "stored-token");
    plugin.app.secretStorage.setSecret(
      "synch-remote-vault-key",
      encodeBase64(remoteVaultKey),
    );
  } else {
    await new ObsidianAuthSessionTokenStore(plugin).write("stored-token");
    await writeStoredRemoteVaultKeySecret(plugin, { remoteVaultKey });
  }
  return plugin;
}

export function mockOnlineReadinessRequests(): void {
  setRequestUrlMock(
    vi.fn(async (input: unknown) => {
      const url = String((input as { url?: string }).url ?? "");
      if (url.endsWith("/v1/sync/token")) {
        return { status: 200, json: { token: "sync-token", expiresAt: Math.floor(Date.now() / 1000) + 120, vaultId: "vault-1", localVaultId: "local-vault-1" } };
      }
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
