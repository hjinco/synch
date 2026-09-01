import type { Plugin } from "obsidian";

const SECRET_SCOPE_ID_KEY = "synch.secretScopeId";

/**
 * Secret storage needs an identity that survives sync-store resets. The sync
 * local vault ID is intentionally cleared when local sync state is reset, so
 * it must not be used as the secret namespace.
 */
export function getOrCreateSecretScopeId(plugin: Plugin): string {
  const existing = readSecretScopeId(plugin);
  if (existing) {
    return existing;
  }

  const created = crypto.randomUUID();
  plugin.app.saveLocalStorage(SECRET_SCOPE_ID_KEY, created);
  return created;
}

function readSecretScopeId(plugin: Plugin): string {
  return readString(plugin, SECRET_SCOPE_ID_KEY);
}

function readString(plugin: Plugin, key: string): string {
  const value = plugin.app.loadLocalStorage(key) as unknown;
  return typeof value === "string" ? value.trim() : "";
}
