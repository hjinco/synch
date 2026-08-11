import type {
  SyncBlobStore,
  SyncConnectionStore,
  SyncCursorStore,
  SyncEntryStore,
  SyncLocalEntryStore,
  SyncMutationStore,
  SyncPushAcceptanceStore,
  SyncReconcileStore,
  SyncRemoteEntryStore,
  SyncStoreLifecycle,
} from "./ports";
import type { SyncedEntryMetadata } from "../core/content";

export interface RemoteSyncEntryRow {
  entryId: string;
  path: string | null;
  revision: number;
  blobId: string | null;
  hash: string | null;
  deleted: boolean;
  updatedAt: number;
}

export interface LocalSyncEntryRow {
  entryId: string;
  path: string | null;
  blobId: string | null;
  hash: string | null;
  deleted: boolean;
  updatedAt: number;
  localMtime: number | null;
  localSize: number | null;
}

export interface SyncEntryRow extends RemoteSyncEntryRow {
  localMtime: number | null;
  localSize: number | null;
}

export interface BaseSyncEntryRow {
  entryId: string;
  path: string | null;
  revision: number;
  blobId: string | null;
  hash: string | null;
  deleted: boolean;
}

export interface SyncEntryStateRow {
  entryId: string;
  remote: RemoteSyncEntryRow | null;
  base: BaseSyncEntryRow;
  local: LocalSyncEntryRow | null;
  dirty: PendingMutationRow | null;
}

export interface CachedSyncBlobRow {
  blobId: string;
  hash: string | null;
  encryptedBytes: Uint8Array;
  cachedAt: number;
  role?: SyncBlobRole;
  refEntryId?: string | null;
}

export type SyncBlobRole = "base" | "remote" | "local-cache";

export type PendingMutationBlockedReason = "file_too_large";

export interface PendingMutationRow {
  mutationId: string;
  entryId: string;
  op: "upsert" | "delete";
  status?: "pending" | "blocked";
  blockedReason?: PendingMutationBlockedReason | null;
  blockedEncryptedSizeBytes?: number | null;
  blockedMaxFileSizeBytes?: number | null;
  baseRevision: number;
  baseBlobId?: string | null;
  baseHash?: string | null;
  blobId: string | null;
  hash: string | null;
  encryptedMetadata: string;
  createdAt: number;
}

export interface MarkEntryDirtyOptions {
  requireBaseBlob?: boolean;
}

export interface SyncReconcileEntryState {
  entryId: string;
  remote: RemoteSyncEntryRow | null;
  local: LocalSyncEntryRow | null;
  dirty: PendingMutationRow | null;
}

export interface SyncReconcileEntryUpdate {
  entryId: string;
  local?: LocalSyncEntryRow;
  dirty?: PendingMutationRow | null;
  clearDirty?: boolean;
  deleteEntry?: boolean;
  requireBaseBlob?: boolean;
}

export interface SyncConnection {
  localVaultId: string;
  remoteVaultId: string;
  lastPulledCursor: number;
}

export interface SyncProgressCounts {
  completedEntries: number;
  totalEntries: number;
}

export interface AcceptedPushMutationRow {
  mutation: PendingMutationRow;
  metadata: SyncedEntryMetadata;
  acceptedRevision: number;
  remoteBlobId: string | null;
  localHash: string | null;
  acceptedAt: number;
  remoteCacheBlob?: CachedSyncBlobRow | null;
}

export interface SyncStore
  extends SyncConnectionStore,
    SyncRemoteEntryStore,
    SyncLocalEntryStore,
    SyncEntryStore,
    SyncCursorStore,
    SyncMutationStore,
    SyncPushAcceptanceStore,
    SyncReconcileStore,
    SyncBlobStore,
    SyncStoreLifecycle {}
