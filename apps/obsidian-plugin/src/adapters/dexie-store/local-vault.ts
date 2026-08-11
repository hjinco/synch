import type { Plugin } from "obsidian";

const LOCAL_VAULT_ID_KEY = "synch.localVaultId";

interface VaultLocalStorageLike {
  loadLocalStorage(key: string): unknown;
  saveLocalStorage(key: string, data: unknown): void;
}

export function getOrCreateLocalVaultId(plugin: Plugin): string {
  const existing = readLocalVaultId(plugin);
  if (existing) {
    return existing;
  }

  const created = crypto.randomUUID();
  writeVaultLocalStorage(plugin, LOCAL_VAULT_ID_KEY, created);
  return created;
}

export function readLocalVaultId(plugin: Plugin): string {
  return readString(plugin, LOCAL_VAULT_ID_KEY);
}

export function clearLocalVaultId(plugin: Plugin): void {
  writeVaultLocalStorage(plugin, LOCAL_VAULT_ID_KEY, null);
}

function readString(plugin: Plugin, key: string): string {
  const value = vaultLocalStorage(plugin).loadLocalStorage(key);
  return typeof value === "string" ? value.trim() : "";
}

function writeVaultLocalStorage(plugin: Plugin, key: string, value: unknown): void {
  vaultLocalStorage(plugin).saveLocalStorage(key, value);
}

function vaultLocalStorage(plugin: Plugin): VaultLocalStorageLike {
  return plugin.app;
}
