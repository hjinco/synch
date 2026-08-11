import type {
  CachedSyncBlobRow,
  PendingMutationBlockedReason,
  SyncBlobRole,
} from "@synch/sync-client/sync/store/store";

export interface MetadataRecord {
  id: string;
  remoteVaultId: string | null;
  lastPulledCursor: number;
  progressCompletedEntries?: number;
  progressTotalEntries?: number;
}

export type PendingMutationStatus = "pending" | "blocked";
export type PendingMutationOp = "upsert" | "delete";

export interface EntryRecord {
  entryId: string;

  remoteKnown: boolean;
  remotePath: string | null;
  remoteRevision: number;
  remoteBlobId: string | null;
  remoteHash: string | null;
  remoteDeleted: boolean;
  remoteUpdatedAt: number;

  basePath: string | null;
  baseRevision: number;
  baseBlobId: string | null;
  baseHash: string | null;
  baseDeleted: boolean;

  localKnown: boolean;
  localPath: string | null;
  localBlobId: string | null;
  localHash: string | null;
  localDeleted: boolean;
  localUpdatedAt: number;
  localMtime: number | null;
  localSize: number | null;

  dirty: boolean;
  pendingMutationId: string | null;
  pendingOp: PendingMutationOp | null;
  pendingStatus: PendingMutationStatus | null;
  pendingBlockedReason: PendingMutationBlockedReason | null;
  pendingBlockedEncryptedSizeBytes: number | null;
  pendingBlockedMaxFileSizeBytes: number | null;
  pendingBaseRevision: number | null;
  pendingBaseBlobId: string | null;
  pendingBaseHash: string | null;
  pendingBlobId: string | null;
  pendingHash: string | null;
  pendingEncryptedMetadata: string | null;
  pendingCreatedAt: number | null;

  remotePathKey?: string;
  localPathKey?: string;
}

export interface BlobRecord extends CachedSyncBlobRow {
  role: SyncBlobRole;
  refEntryId: string | null;
}
