import type { Plugin } from "obsidian";

import type { AuthSessionTokenStore } from "@synch/sync-client/auth/session-token-store";

const SESSION_TOKEN_SECRET = "synch-session-token";

export class ObsidianAuthSessionTokenStore implements AuthSessionTokenStore {
  constructor(private readonly plugin: Plugin) {}

  async read(): Promise<string> {
    return (
      this.plugin.app.secretStorage.getSecret(SESSION_TOKEN_SECRET)?.trim() ?? ""
    );
  }

  async write(token: string): Promise<void> {
    this.plugin.app.secretStorage.setSecret(SESSION_TOKEN_SECRET, token.trim());
  }

  async clear(): Promise<void> {
    this.plugin.app.secretStorage.setSecret(SESSION_TOKEN_SECRET, "");
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
