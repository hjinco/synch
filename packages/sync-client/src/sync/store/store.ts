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

/** A remote revision omitted by this device's file selection. Keep it separate
 * from the last applied revision used as the base for local edits. */
export interface DeferredSyncFile {
  entryId: string;
  path: string;
  revision: number;
}

export interface DeferredSyncFileStore {
  get(entryId: string): Promise<DeferredSyncFile | undefined>;
  getMany(entryIds: string[]): Promise<(DeferredSyncFile | undefined)[]>;
  list(): Promise<DeferredSyncFile[]>;
  /** Atomically record the deferral and release any vacated remote path claim. */
  put(files: DeferredSyncFile[]): Promise<void>;
  remove(entryIds: string[]): Promise<void>;
}

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

export type PendingMutationBlockedReason = "file_too_large" | "incompatible_path";

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

/** Durable until the merged file and its rebased upload are both committed. */
export interface TextMergeIntent {
  kind?: "merge";
  entryId: string;
  path: string;
  sourceHash: string;
  sourceMutationId: string;
  installed?: boolean;
  /** Keep the live source and install this merge as a sibling conflict copy. */
  keepSource?: boolean;
  /** Authenticated ciphertext. Older journals contain only the hashes. */
  staged?: {
    sourceBlobId: string;
    sourceCiphertext: string;
    mergedCiphertext: string;
  };
  remoteUpdatedAt: number;
  mutation: PendingMutationRow & {
    op: "upsert";
    hash: string;
    blobId: string;
    baseHash: string;
    baseBlobId: string;
  };
}

/** A cached Markdown base can be referenced directly. Other bytes live only
 * for the duration of the install, encrypted with a blob-specific context. */
export interface JournalBlob {
  blobId: string;
  hash: string;
  ciphertext?: string;
}

export interface RemoteWriteIntent {
  kind: "download";
  entryId: string;
  path: string;
  /** Physical spelling when a shared directory keeps its local name. */
  localPath?: string;
  revision: number;
  remoteUpdatedAt: number;
  journalId: string;
  createdAt: number;
  source: JournalBlob | null;
  target: JournalBlob;
  pendingMutationId: string | null;
  displaced?: { path: string; restorePrevious: boolean };
}

export type PullWriteIntent = TextMergeIntent | RemoteWriteIntent;

export interface TextMergeJournal {
  get(entryId: string): Promise<PullWriteIntent | undefined>;
  listEntryIds(): Promise<string[]>;
  put(intent: PullWriteIntent): Promise<void>;
  remove(entryId: string): Promise<void>;
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
    SyncStoreLifecycle {
  readonly textMerges: TextMergeJournal;
  /** Present on hosts offering device-specific file selection. */
  readonly deferredFiles?: DeferredSyncFileStore;
}
