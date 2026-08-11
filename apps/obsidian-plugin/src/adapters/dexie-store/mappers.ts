import type {
  CachedSyncBlobRow,
  LocalSyncEntryRow,
  PendingMutationRow,
  RemoteSyncEntryRow,
  SyncConnection,
  SyncEntryRow,
  SyncEntryStateRow,
} from "@synch/sync-client/sync/store/store";
import type { BlobRecord, EntryRecord, MetadataRecord } from "./records";

export function toSyncConnection(
  localVaultId: string,
  metadata: MetadataRecord | null | undefined,
): SyncConnection | null {
  const remoteVaultId = metadata?.remoteVaultId?.trim() ?? "";
  if (!localVaultId || !remoteVaultId) {
    return null;
  }

  return {
    localVaultId,
    remoteVaultId,
    lastPulledCursor: metadata?.lastPulledCursor ?? 0,
  };
}

export function createEmptyEntryRecord(entryId: string): EntryRecord {
  return {
    entryId,
    remoteKnown: false,
    remotePath: null,
    remoteRevision: 0,
    remoteBlobId: null,
    remoteHash: null,
    remoteDeleted: true,
    remoteUpdatedAt: 0,
    basePath: null,
    baseRevision: 0,
    baseBlobId: null,
    baseHash: null,
    baseDeleted: true,
    localKnown: false,
    localPath: null,
    localBlobId: null,
    localHash: null,
    localDeleted: true,
    localUpdatedAt: 0,
    localMtime: null,
    localSize: null,
    dirty: false,
    pendingMutationId: null,
    pendingOp: null,
    pendingStatus: null,
    pendingBlockedReason: null,
    pendingBlockedEncryptedSizeBytes: null,
    pendingBlockedMaxFileSizeBytes: null,
    pendingBaseRevision: null,
    pendingBaseBlobId: null,
    pendingBaseHash: null,
    pendingBlobId: null,
    pendingHash: null,
    pendingEncryptedMetadata: null,
    pendingCreatedAt: null,
  };
}

export function normalizeEntryRecord(entry: EntryRecord): EntryRecord {
  return {
    ...entry,
    remotePathKey:
      entry.remoteKnown && entry.remotePath && !entry.remoteDeleted
        ? entry.remotePath
        : undefined,
    localPathKey:
      entry.localKnown && entry.localPath && !entry.localDeleted
        ? entry.localPath
        : undefined,
  };
}

export function copyRemoteToBase(entry: EntryRecord): void {
  entry.basePath = entry.remotePath;
  entry.baseRevision = entry.remoteRevision;
  entry.baseBlobId = entry.remoteBlobId;
  entry.baseHash = entry.remoteHash;
  entry.baseDeleted = entry.remoteDeleted;
}

export function toRemoteEntryRow(row: EntryRecord): RemoteSyncEntryRow {
  return {
    entryId: row.entryId,
    path: row.remotePath,
    revision: row.remoteRevision,
    blobId: row.remoteBlobId,
    hash: row.remoteHash,
    deleted: row.remoteDeleted,
    updatedAt: row.remoteUpdatedAt,
  };
}

export function toLocalEntryRow(row: EntryRecord): LocalSyncEntryRow {
  return {
    entryId: row.entryId,
    path: row.localPath,
    blobId: row.localBlobId,
    hash: row.localHash,
    deleted: row.localDeleted,
    updatedAt: row.localUpdatedAt,
    localMtime: row.localMtime,
    localSize: row.localSize,
  };
}

export function toCombinedEntryRow(row: EntryRecord): SyncEntryRow | null {
  if (!row.remoteKnown && !row.localKnown) {
    return null;
  }

  return {
    entryId: row.entryId,
    path: row.localKnown ? row.localPath : row.remotePath,
    revision: row.remoteKnown ? row.remoteRevision : 0,
    blobId: row.localKnown ? row.localBlobId : row.remoteBlobId,
    hash: row.localKnown ? row.localHash : row.remoteHash,
    deleted: row.localKnown ? row.localDeleted : row.remoteDeleted,
    updatedAt: row.localKnown ? row.localUpdatedAt : row.remoteUpdatedAt,
    localMtime: row.localKnown ? row.localMtime : null,
    localSize: row.localKnown ? row.localSize : null,
  };
}

export function toEntryStateRow(row: EntryRecord): SyncEntryStateRow {
  return {
    entryId: row.entryId,
    remote: row.remoteKnown ? toRemoteEntryRow(row) : null,
    base: {
      entryId: row.entryId,
      path: row.basePath,
      revision: row.baseRevision,
      blobId: row.baseBlobId,
      hash: row.baseHash,
      deleted: row.baseDeleted,
    },
    local: row.localKnown ? toLocalEntryRow(row) : null,
    dirty: toPendingMutationRow(row),
  };
}

export function toPendingMutationRow(row: EntryRecord): PendingMutationRow | null {
  if (
    !row.dirty ||
    !row.pendingMutationId ||
    !row.pendingOp ||
    !row.pendingStatus ||
    row.pendingBaseRevision === null ||
    row.pendingEncryptedMetadata === null ||
    row.pendingCreatedAt === null
  ) {
    return null;
  }

  const mutation: PendingMutationRow = {
    mutationId: row.pendingMutationId,
    entryId: row.entryId,
    op: row.pendingOp,
    baseRevision: row.pendingBaseRevision,
    blobId: row.pendingBlobId,
    hash: row.pendingHash,
    encryptedMetadata: row.pendingEncryptedMetadata,
    createdAt: row.pendingCreatedAt,
  };
  if (row.pendingBaseBlobId !== null) {
    mutation.baseBlobId = row.pendingBaseBlobId;
  }
  if (row.pendingBaseHash !== null) {
    mutation.baseHash = row.pendingBaseHash;
  }
  if (row.pendingStatus === "blocked") {
    mutation.status = row.pendingStatus;
    mutation.blockedReason = row.pendingBlockedReason;
    mutation.blockedEncryptedSizeBytes = row.pendingBlockedEncryptedSizeBytes ?? null;
    mutation.blockedMaxFileSizeBytes = row.pendingBlockedMaxFileSizeBytes ?? null;
  }
  return mutation;
}

export function normalizePendingMutation(
  mutation: PendingMutationRow,
): Required<PendingMutationRow> {
  const status = mutation.status ?? "pending";
  return {
    ...mutation,
    status,
    blockedReason:
      status === "blocked" ? (mutation.blockedReason ?? "file_too_large") : null,
    blockedEncryptedSizeBytes:
      status === "blocked" ? (mutation.blockedEncryptedSizeBytes ?? null) : null,
    blockedMaxFileSizeBytes:
      status === "blocked" ? (mutation.blockedMaxFileSizeBytes ?? null) : null,
    baseBlobId: mutation.baseBlobId ?? null,
    baseHash: mutation.baseHash ?? null,
  };
}

export function toDirtyEntryRecord(
  entry: EntryRecord,
  mutation: Required<PendingMutationRow>,
): EntryRecord {
  const updated: EntryRecord = {
    ...entry,
    dirty: true,
    pendingMutationId: mutation.mutationId,
    pendingOp: mutation.op,
    pendingStatus: mutation.status,
    pendingBlockedReason: mutation.blockedReason,
    pendingBlockedEncryptedSizeBytes: mutation.blockedEncryptedSizeBytes,
    pendingBlockedMaxFileSizeBytes: mutation.blockedMaxFileSizeBytes,
    pendingBaseRevision: mutation.baseRevision,
    pendingBaseBlobId: mutation.baseBlobId,
    pendingBaseHash: mutation.baseHash,
    pendingBlobId: mutation.blobId,
    pendingHash: mutation.hash,
    pendingEncryptedMetadata: mutation.encryptedMetadata,
    pendingCreatedAt: mutation.createdAt,
    baseRevision: mutation.baseRevision,
    baseBlobId: mutation.baseBlobId,
    baseHash: mutation.baseHash,
  };

  if (entry.remoteKnown) {
    updated.basePath = entry.remotePath;
    updated.baseDeleted = entry.remoteDeleted;
  }

  return updated;
}

export function clearPendingMutation(entry: EntryRecord): EntryRecord {
  return {
    ...entry,
    dirty: false,
    pendingMutationId: null,
    pendingOp: null,
    pendingStatus: null,
    pendingBlockedReason: null,
    pendingBlockedEncryptedSizeBytes: null,
    pendingBlockedMaxFileSizeBytes: null,
    pendingBaseRevision: null,
    pendingBaseBlobId: null,
    pendingBaseHash: null,
    pendingBlobId: null,
    pendingHash: null,
    pendingEncryptedMetadata: null,
    pendingCreatedAt: null,
  };
}

export function hasPendingMutationRecord(row: EntryRecord): boolean {
  return toPendingMutationRow(row) !== null;
}

export function toBlobRecord(blob: CachedSyncBlobRow): BlobRecord {
  return {
    blobId: blob.blobId,
    hash: blob.hash,
    encryptedBytes: new Uint8Array(blob.encryptedBytes),
    role: blob.role ?? "base",
    refEntryId: blob.refEntryId ?? null,
    cachedAt: blob.cachedAt,
  };
}

export function toCachedBlobRow(row: BlobRecord): CachedSyncBlobRow {
  return {
    blobId: row.blobId,
    hash: row.hash,
    encryptedBytes: new Uint8Array(row.encryptedBytes),
    cachedAt: row.cachedAt,
  };
}

export function sortEntryRows<T extends { updatedAt: number; entryId: string }>(
  rows: T[],
): T[] {
  return [...rows].sort((left, right) => {
    if (left.updatedAt !== right.updatedAt) {
      return left.updatedAt - right.updatedAt;
    }
    return left.entryId.localeCompare(right.entryId);
  });
}

export function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
