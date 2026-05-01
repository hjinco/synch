// Import the Dexie ESM build directly. The package root uses a global singleton
// wrapper that can throw when another Obsidian plugin has loaded a different
// Dexie version in the same app window.
import Dexie from "dexie/dist/dexie.mjs";
import type { Plugin } from "obsidian";

import { METADATA_ID, SyncDexieDatabase, syncStoreDbName } from "./database";
import {
  clearLocalVaultId,
  getOrCreateLocalVaultId,
  readLocalVaultId,
} from "./local-vault";
import { toSyncConnection } from "./mappers";
import { DexieSyncStore } from "./store";
import type { SyncConnection, SyncStore } from "../store";

export async function createDexieSyncStore(plugin: Plugin): Promise<SyncStore> {
  const store = new DexieSyncStore(plugin, getOrCreateLocalVaultId(plugin));
  await store.initialize();
  return store;
}

export async function clearDexieSyncStore(plugin: Plugin): Promise<void> {
  const localVaultId = readLocalVaultId(plugin);
  if (localVaultId) {
    await Dexie.delete(syncStoreDbName(localVaultId));
  }

  clearLocalVaultId(plugin);
}

export async function readDexieSyncStoreConnection(
  plugin: Plugin,
): Promise<SyncConnection | null> {
  const localVaultId = readLocalVaultId(plugin);
  if (!localVaultId) {
    return null;
  }

  const db = new SyncDexieDatabase(syncStoreDbName(localVaultId));
  try {
    const metadata = await db.metadata.get(METADATA_ID);
    return toSyncConnection(localVaultId, metadata);
  } finally {
    db.close();
  }
}
