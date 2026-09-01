import type { Plugin } from "obsidian";

import type { AuthSessionTokenStore } from "@synch/sync-client/auth/session-token-store";
import { getOrCreateSecretScopeId } from "./secret-scope";

const LEGACY_SESSION_TOKEN_SECRET = "synch-session-token";

function sessionTokenSecretName(secretScopeId: string): string {
  return `${LEGACY_SESSION_TOKEN_SECRET}-${secretScopeId}`;
}

export async function migrateLegacyAuthSessionToken(plugin: Plugin): Promise<void> {
  try {
    const secretScopeId = getOrCreateSecretScopeId(plugin);
    const scopedSecretName = sessionTokenSecretName(secretScopeId);
    const scopedToken =
      plugin.app.secretStorage.getSecret(scopedSecretName)?.trim() ?? "";
    if (scopedToken) {
      plugin.app.secretStorage.setSecret(LEGACY_SESSION_TOKEN_SECRET, "");
      return;
    }

    const legacyToken =
      plugin.app.secretStorage.getSecret(LEGACY_SESSION_TOKEN_SECRET)?.trim() ?? "";
    if (!legacyToken) {
      return;
    }

    plugin.app.secretStorage.setSecret(scopedSecretName, legacyToken);
    plugin.app.secretStorage.setSecret(LEGACY_SESSION_TOKEN_SECRET, "");
  } catch {
    // Leave the legacy secret untouched if copying fails so the next plugin
    // start can retry without turning the storage error into sign-out.
  }
}

export class ObsidianAuthSessionTokenStore implements AuthSessionTokenStore {
  constructor(private readonly plugin: Plugin) {}

  async read(): Promise<string> {
    try {
      const secretScopeId = getOrCreateSecretScopeId(this.plugin);
      return (
        this.plugin.app.secretStorage
          .getSecret(sessionTokenSecretName(secretScopeId))
          ?.trim() ?? ""
      );
    } catch {
      return "";
    }
  }

  async write(token: string): Promise<void> {
    const secretScopeId = getOrCreateSecretScopeId(this.plugin);
    this.plugin.app.secretStorage.setSecret(
      sessionTokenSecretName(secretScopeId),
      token.trim(),
    );
    this.plugin.app.secretStorage.setSecret(LEGACY_SESSION_TOKEN_SECRET, "");
  }

  async clear(): Promise<void> {
    const secretScopeId = getOrCreateSecretScopeId(this.plugin);
    this.plugin.app.secretStorage.setSecret(
      sessionTokenSecretName(secretScopeId),
      "",
    );
    this.plugin.app.secretStorage.setSecret(LEGACY_SESSION_TOKEN_SECRET, "");
  }
}

export async function readAuthSessionToken(plugin: Plugin): Promise<string> {
  return await new ObsidianAuthSessionTokenStore(plugin).read();
}

export async function writeAuthSessionToken(
  plugin: Plugin,
  sessionToken: string,
): Promise<void> {
  await new ObsidianAuthSessionTokenStore(plugin).write(sessionToken);
}

export async function clearAuthSessionToken(plugin: Plugin): Promise<void> {
  await new ObsidianAuthSessionTokenStore(plugin).clear();
}
