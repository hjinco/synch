// Import the Dexie ESM build directly. The package root uses a global singleton
// wrapper that can throw when another Obsidian plugin has loaded a different
// Dexie version in the same app window.
import Dexie, { type Table } from "dexie/dist/dexie.mjs";

import type { BlobRecord, EntryRecord, MetadataRecord } from "./records";

const DB_NAMESPACE_VERSION = "v1";
const ENTRIES_SCHEMA =
  "&entryId,&remotePathKey,&localPathKey,dirty,pendingStatus,pendingMutationId,[dirty+pendingCreatedAt+entryId],[pendingStatus+pendingCreatedAt+entryId]";

export const METADATA_ID = "sync";
export const MIN_PENDING_CREATED_AT = 0;

export class SyncDexieDatabase extends Dexie {
  metadata!: Table<MetadataRecord, string>;
  entries!: Table<EntryRecord, string>;
  blobs!: Table<BlobRecord, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      metadata: "&id",
      entries: ENTRIES_SCHEMA,
      blobs: "&blobId,hash,role,refEntryId,cachedAt",
    });
  }
}

export function syncStoreDbName(localVaultId: string): string {
  return `synch:sync-store:${DB_NAMESPACE_VERSION}:${localVaultId}`;
}
