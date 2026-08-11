import { decryptSyncMetadata, encryptSyncMetadata } from "../core/crypto";
import type {
  AcceptedPushMutationRow,
  CachedSyncBlobRow,
  LocalSyncEntryRow,
  PendingMutationBlockedReason,
  PendingMutationRow,
  RemoteSyncEntryRow,
  SyncBlobRole,
  SyncEntryRow,
  SyncEntryStateRow,
} from "./store";

export type PendingMutationStatus = "pending" | "blocked";
export type PendingMutationOp = "upsert" | "delete";

/**
 * Denormalized per-entry persistence record shared by the sync store
 * adapters (Dexie in the Obsidian plugin, SQLite in the CLI). Keeping the
 * record shape and its state-transition helpers here ensures every adapter
 * applies identical base/pending-mutation semantics.
 */
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

  /**
   * Unique lookup keys for the currently visible (non-deleted) paths.
   * `normalizeEntryRecord` sets them to `undefined` when absent so IndexedDB
   * unique indexes skip the record; SQL adapters map `undefined` to NULL.
   */
  remotePathKey?: string | null;
  localPathKey?: string | null;
}

export interface BlobRecord extends CachedSyncBlobRow {
  role: SyncBlobRole;
  refEntryId: string | null;
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

export interface AcceptedPushApplyPlan {
  rebase: {
    pendingMutationId: string;
    encryptedMetadata: string;
  } | null;
}

/**
 * Prepares the (async) crypto work needed to apply an accepted push to an
 * entry: when a newer mutation is still pending, its metadata is re-encrypted
 * against the accepted revision. Runs outside the adapter's storage
 * transaction; `applyAcceptedPushToEntry` verifies the plan still matches and
 * returns "retry" when the entry changed in between.
 */
export async function planAcceptedPushApply(
  row: EntryRecord,
  accepted: AcceptedPushMutationRow,
  remoteVaultKey: Uint8Array,
): Promise<AcceptedPushApplyPlan> {
  const currentPending = toPendingMutationRow(row);
  if (!currentPending || currentPending.mutationId === accepted.mutation.mutationId) {
    return { rebase: null };
  }

  const pendingMetadata = await decryptSyncMetadata(
    remoteVaultKey,
    currentPending.encryptedMetadata,
    metadataContextFromMutation(currentPending),
  );

  return {
    rebase: {
      pendingMutationId: currentPending.mutationId,
      encryptedMetadata: await encryptSyncMetadata(
        remoteVaultKey,
        pendingMetadata,
        metadataContextFromMutation({
          ...currentPending,
          baseRevision: accepted.acceptedRevision,
          baseBlobId: accepted.remoteBlobId,
          baseHash: accepted.localHash,
        }),
      ),
    },
  };
}

export function applyAcceptedPushToEntry(
  row: EntryRecord,
  accepted: AcceptedPushMutationRow,
  plan: AcceptedPushApplyPlan,
): EntryRecord | "retry" {
  const { mutation, metadata } = accepted;
  let updated: EntryRecord = {
    ...row,
    remoteKnown: true,
    remotePath: metadata.path,
    remoteRevision: accepted.acceptedRevision,
    remoteBlobId: mutation.op === "delete" ? null : accepted.remoteBlobId,
    remoteHash: mutation.op === "delete" ? null : accepted.localHash,
    remoteDeleted: mutation.op === "delete",
    remoteUpdatedAt: accepted.acceptedAt,
  };

  if (mutation.op === "upsert" && shouldApplyAcceptedPushToLocal(updated, accepted)) {
    updated = {
      ...updated,
      localKnown: true,
      localPath: metadata.path,
      localBlobId: accepted.remoteBlobId,
      localHash: accepted.localHash,
      localDeleted: false,
      localUpdatedAt: accepted.acceptedAt,
      localMtime: updated.localMtime,
      localSize: updated.localSize,
    };
  }

  const currentPending = toPendingMutationRow(updated);
  if (!currentPending) {
    copyRemoteToBase(updated);
    return updated;
  }

  if (currentPending.mutationId === mutation.mutationId) {
    updated = clearPendingMutation(updated);
    copyRemoteToBase(updated);
    return updated;
  }

  if (plan.rebase?.pendingMutationId !== currentPending.mutationId) {
    return "retry";
  }

  return toDirtyEntryRecord(
    updated,
    normalizePendingMutation({
      ...currentPending,
      baseRevision: accepted.acceptedRevision,
      baseBlobId: accepted.remoteBlobId,
      baseHash: accepted.localHash,
      encryptedMetadata: plan.rebase.encryptedMetadata,
    }),
  );
}

function shouldApplyAcceptedPushToLocal(
  row: EntryRecord,
  accepted: AcceptedPushMutationRow,
): boolean {
  return (
    !row.localKnown ||
    (row.localHash === accepted.mutation.hash &&
      row.localPath === accepted.metadata.path)
  );
}

function metadataContextFromMutation(mutation: PendingMutationRow) {
  return {
    entryId: mutation.entryId,
    revision: mutation.baseRevision + 1,
    op: mutation.op,
    blobId: mutation.blobId,
  };
}
