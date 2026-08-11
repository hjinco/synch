import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import type {
  AcceptedPushApplyPlan,
  BlobRecord,
  EntryRecord,
} from "@synch/sync-client/sync/store/entry-record";
import {
  applyAcceptedPushToEntry,
  clearPendingMutation,
  copyRemoteToBase,
  createEmptyEntryRecord,
  isPresent,
  normalizeEntryRecord,
  normalizePendingMutation,
  planAcceptedPushApply,
  sortEntryRows,
  toBlobRecord,
  toCachedBlobRow,
  toCombinedEntryRow,
  toDirtyEntryRecord,
  toEntryStateRow,
  toLocalEntryRow,
  toPendingMutationRow,
  toRemoteEntryRow,
} from "@synch/sync-client/sync/store/entry-record";
import type {
  AcceptedPushMutationRow,
  CachedSyncBlobRow,
  LocalSyncEntryRow,
  MarkEntryDirtyOptions,
  PendingMutationBlockedReason,
  PendingMutationRow,
  RemoteSyncEntryRow,
  SyncConnection,
  SyncEntryRow,
  SyncEntryStateRow,
  SyncProgressCounts,
  SyncReconcileEntryState,
  SyncReconcileEntryUpdate,
  SyncStore,
} from "@synch/sync-client/sync/store/store";
import { SQLITE_STORE_SCHEMA } from "./schema";

const ACCEPTED_PUSH_BATCH_MAX_RETRIES = 3;

const ENTRY_COLUMNS = [
  "entry_id",
  "remote_known",
  "remote_path",
  "remote_revision",
  "remote_blob_id",
  "remote_hash",
  "remote_deleted",
  "remote_updated_at",
  "base_path",
  "base_revision",
  "base_blob_id",
  "base_hash",
  "base_deleted",
  "local_known",
  "local_path",
  "local_blob_id",
  "local_hash",
  "local_deleted",
  "local_updated_at",
  "local_mtime",
  "local_size",
  "dirty",
  "pending_mutation_id",
  "pending_op",
  "pending_status",
  "pending_blocked_reason",
  "pending_blocked_encrypted_size_bytes",
  "pending_blocked_max_file_size_bytes",
  "pending_base_revision",
  "pending_base_blob_id",
  "pending_base_hash",
  "pending_blob_id",
  "pending_hash",
  "pending_encrypted_metadata",
  "pending_created_at",
  "remote_path_key",
  "local_path_key",
] as const;

// Upsert keyed on entry_id only. INSERT OR REPLACE would also resolve
// remote_path_key/local_path_key unique-index conflicts by silently deleting
// the other entry's row (possibly holding a pending mutation); this form
// raises instead, matching the Dexie adapter's ConstraintError behavior.
const PUT_ENTRY_SQL = `INSERT INTO entries (${ENTRY_COLUMNS.join(", ")}) VALUES (${ENTRY_COLUMNS.map(() => "?").join(", ")})
  ON CONFLICT(entry_id) DO UPDATE SET ${ENTRY_COLUMNS.filter((column) => column !== "entry_id")
    .map((column) => `${column} = excluded.${column}`)
    .join(", ")}`;

export class SqliteSyncStore implements SyncStore {
  private readonly statements = new Map<string, StatementSync>();
  private transactionDepth = 0;

  private constructor(
    private readonly db: DatabaseSync,
    private readonly localVaultId: string,
  ) {}

  static open(dbPath: string): SqliteSyncStore {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(SQLITE_STORE_SCHEMA);

    const existing = db
      .prepare("SELECT local_vault_id FROM metadata WHERE id = 'sync'")
      .get() as { local_vault_id: string } | undefined;
    let localVaultId = existing?.local_vault_id ?? "";
    if (!localVaultId) {
      localVaultId = crypto.randomUUID();
      db.prepare(
        "INSERT INTO metadata (id, local_vault_id, remote_vault_id, last_pulled_cursor) VALUES ('sync', ?, NULL, 0)",
      ).run(localVaultId);
    }

    return new SqliteSyncStore(db, localVaultId);
  }

  async readLocalVaultId(): Promise<string> {
    return this.localVaultId;
  }

  async readSyncConnection(): Promise<SyncConnection | null> {
    const metadata = this.readMetadata();
    const remoteVaultId = metadata.remoteVaultId?.trim() ?? "";
    if (!remoteVaultId) {
      return null;
    }

    return {
      localVaultId: this.localVaultId,
      remoteVaultId,
      lastPulledCursor: metadata.lastPulledCursor,
    };
  }

  async writeSyncConnection(connection: SyncConnection): Promise<void> {
    const localVaultId = connection.localVaultId.trim();
    const remoteVaultId = connection.remoteVaultId.trim();
    if (!localVaultId || !remoteVaultId) {
      throw new Error("Local and remote vault IDs are required.");
    }
    if (localVaultId !== this.localVaultId) {
      throw new Error("Local sync store belongs to a different local vault.");
    }

    this.prepare(
      "UPDATE metadata SET remote_vault_id = ?, last_pulled_cursor = ? WHERE id = 'sync'",
    ).run(remoteVaultId, connection.lastPulledCursor);
  }

  async ensureEntry(entryId: string): Promise<void> {
    this.putEntry(this.getOrCreateEntryRecord(entryId));
  }

  async getRemoteStateById(entryId: string): Promise<RemoteSyncEntryRow | null> {
    const row = this.getEntryRecord(entryId);
    return row?.remoteKnown ? toRemoteEntryRow(row) : null;
  }

  async getRemoteStateByPath(path: string): Promise<RemoteSyncEntryRow | null> {
    const row = this.getEntryRecordByColumn("remote_path_key", path);
    return row?.remoteKnown ? toRemoteEntryRow(row) : null;
  }

  async listRemoteStates(): Promise<RemoteSyncEntryRow[]> {
    return sortEntryRows(
      this.listEntryRecords()
        .filter((row) => row.remoteKnown)
        .map(toRemoteEntryRow),
    );
  }

  async applyRemoteState(entry: RemoteSyncEntryRow): Promise<void> {
    const existing = this.getOrCreateEntryRecord(entry.entryId);
    const updated: EntryRecord = {
      ...existing,
      remoteKnown: true,
      remotePath: entry.path,
      remoteRevision: entry.revision,
      remoteBlobId: entry.blobId,
      remoteHash: entry.hash,
      remoteDeleted: entry.deleted,
      remoteUpdatedAt: entry.updatedAt,
    };

    if (!existing.dirty) {
      copyRemoteToBase(updated);
    }

    this.putEntry(updated);
  }

  async clearRemoteState(entryId: string): Promise<void> {
    const existing = this.getEntryRecord(entryId);
    if (!existing) {
      return;
    }

    const updated: EntryRecord = {
      ...existing,
      remoteKnown: false,
      remotePath: null,
      remoteRevision: 0,
      remoteBlobId: null,
      remoteHash: null,
      remoteDeleted: true,
      remoteUpdatedAt: 0,
    };
    if (!updated.localKnown && !updated.dirty) {
      this.deleteEntryRecord(entryId);
      return;
    }

    this.putEntry(updated);
  }

  async getLocalStateById(entryId: string): Promise<LocalSyncEntryRow | null> {
    const row = this.getEntryRecord(entryId);
    return row?.localKnown ? toLocalEntryRow(row) : null;
  }

  async getLocalStateByPath(path: string): Promise<LocalSyncEntryRow | null> {
    const row = this.getEntryRecordByColumn("local_path_key", path);
    return row?.localKnown ? toLocalEntryRow(row) : null;
  }

  async listLocalStates(): Promise<LocalSyncEntryRow[]> {
    return sortEntryRows(
      this.listEntryRecords()
        .filter((row) => row.localKnown)
        .map(toLocalEntryRow),
    );
  }

  async applyLocalState(entry: LocalSyncEntryRow): Promise<void> {
    const existing = this.getOrCreateEntryRecord(entry.entryId);
    this.putEntry({
      ...existing,
      localKnown: true,
      localPath: entry.path,
      localBlobId: entry.blobId,
      localHash: entry.hash,
      localDeleted: entry.deleted,
      localUpdatedAt: entry.updatedAt,
      localMtime: entry.localMtime,
      localSize: entry.localSize,
    });
  }

  async clearLocalState(entryId: string): Promise<void> {
    const existing = this.getEntryRecord(entryId);
    if (!existing) {
      return;
    }

    const updated: EntryRecord = {
      ...existing,
      localKnown: false,
      localPath: null,
      localBlobId: null,
      localHash: null,
      localDeleted: true,
      localUpdatedAt: 0,
      localMtime: null,
      localSize: null,
    };
    if (!updated.remoteKnown && !updated.dirty) {
      this.deleteEntryRecord(entryId);
      return;
    }

    this.putEntry(updated);
  }

  async getEntryById(entryId: string): Promise<SyncEntryRow | null> {
    const row = this.getEntryRecord(entryId);
    return row ? toCombinedEntryRow(row) : null;
  }

  async getEntryByPath(path: string): Promise<SyncEntryRow | null> {
    return this.getEntryRowByPath(path);
  }

  async getEntryStateById(entryId: string): Promise<SyncEntryStateRow | null> {
    const row = this.getEntryRecord(entryId);
    return row ? toEntryStateRow(row) : null;
  }

  async listEntries(): Promise<SyncEntryRow[]> {
    return sortEntryRows(
      this.listEntryRecords()
        .map(toCombinedEntryRow)
        .filter((entry): entry is SyncEntryRow => !!entry),
    );
  }

  async countSyncProgress(): Promise<SyncProgressCounts> {
    const row = this.prepare(
      `SELECT
         COALESCE(SUM(has_pending OR NOT deleted), 0) AS total_entries,
         COALESCE(SUM((NOT has_pending) AND (NOT deleted) AND remote_completed), 0) AS completed_entries
       FROM (
         SELECT
           (dirty = 1
             AND pending_mutation_id IS NOT NULL
             AND pending_op IS NOT NULL
             AND pending_status IS NOT NULL
             AND pending_base_revision IS NOT NULL
             AND pending_encrypted_metadata IS NOT NULL
             AND pending_created_at IS NOT NULL) AS has_pending,
           CASE
             WHEN local_known = 1 THEN local_deleted
             WHEN remote_known = 1 THEN remote_deleted
             ELSE 1
           END AS deleted,
           (remote_known = 1 AND remote_revision > 0) AS remote_completed
         FROM entries
       )`,
    ).get() as { total_entries: number; completed_entries: number };

    return {
      completedEntries: row.completed_entries,
      totalEntries: row.total_entries,
    };
  }

  async getOrCreateEntryId(path: string): Promise<string> {
    return this.getEntryRowByPath(path)?.entryId ?? crypto.randomUUID();
  }

  async upsertEntry(entry: SyncEntryRow): Promise<void> {
    this.putEntry({
      ...createEmptyEntryRecord(entry.entryId),
      remoteKnown: true,
      remotePath: entry.path,
      remoteRevision: entry.revision,
      remoteBlobId: entry.blobId,
      remoteHash: entry.hash,
      remoteDeleted: entry.deleted,
      remoteUpdatedAt: entry.updatedAt,
      basePath: entry.path,
      baseRevision: entry.revision,
      baseBlobId: entry.blobId,
      baseHash: entry.hash,
      baseDeleted: entry.deleted,
      localKnown: true,
      localPath: entry.path,
      localBlobId: entry.blobId,
      localHash: entry.hash,
      localDeleted: entry.deleted,
      localUpdatedAt: entry.updatedAt,
      localMtime: entry.localMtime,
      localSize: entry.localSize,
    });
  }

  async deleteEntry(entryId: string): Promise<void> {
    this.deleteEntryRecord(entryId);
  }

  async getCursor(): Promise<number> {
    return this.readMetadata().lastPulledCursor;
  }

  async setCursor(cursor: number): Promise<void> {
    const connection = await this.readSyncConnection();
    if (!connection) {
      throw new Error("Sync connection is not initialized.");
    }

    this.prepare(
      "UPDATE metadata SET last_pulled_cursor = ? WHERE id = 'sync'",
    ).run(cursor);
  }

  async markEntryDirty(
    mutation: PendingMutationRow,
    options: MarkEntryDirtyOptions = {},
  ): Promise<void> {
    const normalized = normalizePendingMutation(mutation);
    this.inTransaction(() => {
      if (options.requireBaseBlob) {
        this.assertRequiredBaseBlob(normalized);
      }
      const entry = this.getOrCreateEntryRecord(normalized.entryId);
      this.putEntry(toDirtyEntryRecord(entry, normalized));
    });
  }

  async replaceDirtyEntry(
    mutation: PendingMutationRow,
    options: MarkEntryDirtyOptions = {},
  ): Promise<void> {
    await this.markEntryDirty(mutation, options);
  }

  async getDirtyEntryMutation(entryId: string): Promise<PendingMutationRow | null> {
    const row = this.getEntryRecord(entryId);
    return row ? toPendingMutationRow(row) : null;
  }

  async listDirtyEntries(limit?: number): Promise<PendingMutationRow[]> {
    const sql = `SELECT * FROM entries
       WHERE pending_status = 'pending'
       ORDER BY pending_created_at ASC, entry_id ASC${limit === undefined ? "" : " LIMIT ?"}`;
    const rows = (
      limit === undefined
        ? this.prepare(sql).all()
        : this.prepare(sql).all(limit)
    ) as unknown as SqlEntryRow[];
    return rows
      .map((row) => toPendingMutationRow(fromSqlRow(row)))
      .filter(isPresent);
  }

  async updateDirtyEntry(mutation: PendingMutationRow): Promise<void> {
    await this.markEntryDirty(mutation);
  }

  async listBlockedDirtyEntriesByReason(
    reason: PendingMutationBlockedReason,
  ): Promise<PendingMutationRow[]> {
    const rows = this.prepare(
      "SELECT * FROM entries WHERE pending_status = 'blocked' AND pending_blocked_reason = ?",
    ).all(reason) as unknown as SqlEntryRow[];
    return rows
      .map((row) => toPendingMutationRow(fromSqlRow(row)))
      .filter(isPresent);
  }

  async unblockDirtyEntriesByReason(
    reason: PendingMutationBlockedReason,
  ): Promise<void> {
    const rows = this.prepare(
      "SELECT * FROM entries WHERE pending_status = 'blocked' AND pending_blocked_reason = ?",
    ).all(reason) as unknown as SqlEntryRow[];
    this.inTransaction(() => {
      for (const row of rows) {
        this.putEntry({
          ...fromSqlRow(row),
          pendingStatus: "pending",
          pendingBlockedReason: null,
          pendingBlockedEncryptedSizeBytes: null,
          pendingBlockedMaxFileSizeBytes: null,
        });
      }
    });
  }

  async clearDirtyEntryByMutationId(mutationId: string): Promise<void> {
    const row = this.prepare(
      "SELECT * FROM entries WHERE pending_mutation_id = ?",
    ).get(mutationId) as SqlEntryRow | undefined;
    if (!row) {
      return;
    }

    this.putEntry(clearPendingMutation(fromSqlRow(row)));
  }

  async markEntryClean(entryId: string): Promise<void> {
    const entry = this.getEntryRecord(entryId);
    if (!entry) {
      return;
    }

    this.putEntry(clearPendingMutation(entry));
  }

  async listReconcileEntryStates(): Promise<SyncReconcileEntryState[]> {
    return this.listEntryRecords().map((row) => ({
      entryId: row.entryId,
      remote: row.remoteKnown ? toRemoteEntryRow(row) : null,
      local: row.localKnown ? toLocalEntryRow(row) : null,
      dirty: toPendingMutationRow(row),
    }));
  }

  async applyReconcileEntryUpdates(
    updates: SyncReconcileEntryUpdate[],
  ): Promise<void> {
    if (updates.length === 0) {
      return;
    }

    this.inTransaction(() => {
      for (const update of updates) {
        if (update.deleteEntry) {
          this.deleteEntryRecord(update.entryId);
          continue;
        }

        let row =
          this.getEntryRecord(update.entryId) ??
          createEmptyEntryRecord(update.entryId);
        if (update.dirty !== undefined) {
          if (update.dirty === null) {
            row = clearPendingMutation(row);
          } else {
            const mutation = normalizePendingMutation(update.dirty);
            if (update.requireBaseBlob) {
              this.assertRequiredBaseBlob(mutation);
            }
            row = toDirtyEntryRecord(row, mutation);
          }
        } else if (update.clearDirty) {
          row = clearPendingMutation(row);
        }

        if (update.local) {
          row = {
            ...row,
            localKnown: true,
            localPath: update.local.path,
            localBlobId: update.local.blobId,
            localHash: update.local.hash,
            localDeleted: update.local.deleted,
            localUpdatedAt: update.local.updatedAt,
            localMtime: update.local.localMtime,
            localSize: update.local.localSize,
          };
        }

        this.putEntry(row);
      }
    });
  }

  async getBlob(blobId: string): Promise<CachedSyncBlobRow | null> {
    const record = this.getBlobRecord(blobId);
    return record ? toCachedBlobRow(record) : null;
  }

  async putBlob(blob: CachedSyncBlobRow): Promise<void> {
    this.putBlobRecord(toBlobRecord(blob));
  }

  async applyAcceptedPushBatch(
    accepted: AcceptedPushMutationRow[],
    options: { remoteVaultKey: Uint8Array },
  ): Promise<void> {
    if (accepted.length === 0) {
      return;
    }

    for (let attempt = 0; attempt < ACCEPTED_PUSH_BATCH_MAX_RETRIES; attempt += 1) {
      // The plan phase re-encrypts pending metadata and must await crypto
      // work, so it runs outside the synchronous SQLite transaction and is
      // verified (and retried) inside it.
      const plans = await Promise.all(
        accepted.map((item) =>
          planAcceptedPushApply(
            this.getEntryRecord(item.mutation.entryId) ??
              createEmptyEntryRecord(item.mutation.entryId),
            item,
            options.remoteVaultKey,
          ),
        ),
      );

      const applied = this.inTransaction(() => {
        const rowsToPut: EntryRecord[] = [];
        const blobsToPut: BlobRecord[] = [];

        for (let index = 0; index < accepted.length; index += 1) {
          const item = accepted[index];
          const row =
            this.getEntryRecord(item.mutation.entryId) ??
            createEmptyEntryRecord(item.mutation.entryId);
          const nextRow = applyAcceptedPushToEntry(row, item, plans[index]);
          if (nextRow === "retry") {
            return false;
          }
          rowsToPut.push(nextRow);

          if (item.remoteCacheBlob) {
            blobsToPut.push(toBlobRecord(item.remoteCacheBlob));
          }
        }

        for (const row of rowsToPut) {
          this.putEntry(row);
        }
        for (const blob of blobsToPut) {
          this.putBlobRecord(blob);
        }
        return true;
      });

      if (applied) {
        return;
      }
    }

    throw new Error(
      "Accepted push batch changed while applying; retry limit exceeded.",
    );
  }

  async flush(): Promise<void> {}

  async close(): Promise<void> {
    this.db.close();
  }

  private readMetadata(): { remoteVaultId: string | null; lastPulledCursor: number } {
    const row = this.prepare(
      "SELECT remote_vault_id, last_pulled_cursor FROM metadata WHERE id = 'sync'",
    ).get() as
      | { remote_vault_id: string | null; last_pulled_cursor: number }
      | undefined;
    return {
      remoteVaultId: row?.remote_vault_id ?? null,
      lastPulledCursor: row?.last_pulled_cursor ?? 0,
    };
  }

  private getEntryRowByPath(path: string): SyncEntryRow | null {
    const local = this.getEntryRecordByColumn("local_path_key", path);
    if (local?.localKnown) {
      return toCombinedEntryRow(local);
    }

    const remote = this.getEntryRecordByColumn("remote_path_key", path);
    if (!remote?.remoteKnown) {
      return null;
    }

    if (remote.localKnown && remote.localPath !== path) {
      return null;
    }
    return toCombinedEntryRow(remote);
  }

  private getOrCreateEntryRecord(entryId: string): EntryRecord {
    return this.getEntryRecord(entryId) ?? createEmptyEntryRecord(entryId);
  }

  private getEntryRecord(entryId: string): EntryRecord | null {
    const row = this.prepare("SELECT * FROM entries WHERE entry_id = ?").get(
      entryId,
    ) as SqlEntryRow | undefined;
    return row ? fromSqlRow(row) : null;
  }

  private getEntryRecordByColumn(
    column: "remote_path_key" | "local_path_key",
    value: string,
  ): EntryRecord | null {
    const row = this.prepare(`SELECT * FROM entries WHERE ${column} = ?`).get(
      value,
    ) as SqlEntryRow | undefined;
    return row ? fromSqlRow(row) : null;
  }

  private listEntryRecords(): EntryRecord[] {
    const rows = this.prepare("SELECT * FROM entries").all() as unknown as SqlEntryRow[];
    return rows.map(fromSqlRow);
  }

  private putEntry(entry: EntryRecord): void {
    this.prepare(PUT_ENTRY_SQL).run(...toSqlValues(normalizeEntryRecord(entry)));
  }

  private deleteEntryRecord(entryId: string): void {
    this.prepare("DELETE FROM entries WHERE entry_id = ?").run(entryId);
  }

  private getBlobRecord(blobId: string): BlobRecord | null {
    const row = this.prepare("SELECT * FROM blobs WHERE blob_id = ?").get(
      blobId,
    ) as
      | {
          blob_id: string;
          hash: string | null;
          encrypted_bytes: Uint8Array;
          role: string;
          ref_entry_id: string | null;
          cached_at: number;
        }
      | undefined;
    if (!row) {
      return null;
    }

    return {
      blobId: row.blob_id,
      hash: row.hash,
      encryptedBytes: new Uint8Array(row.encrypted_bytes),
      role: row.role as BlobRecord["role"],
      refEntryId: row.ref_entry_id,
      cachedAt: row.cached_at,
    };
  }

  private putBlobRecord(blob: BlobRecord): void {
    this.prepare(
      "INSERT OR REPLACE INTO blobs (blob_id, hash, encrypted_bytes, role, ref_entry_id, cached_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      blob.blobId,
      blob.hash,
      blob.encryptedBytes,
      blob.role,
      blob.refEntryId,
      blob.cachedAt,
    );
  }

  private assertRequiredBaseBlob(mutation: Required<PendingMutationRow>): void {
    if (!mutation.baseBlobId || !mutation.baseHash) {
      return;
    }

    const blob = this.getBlobRecord(mutation.baseBlobId);
    if (!blob || blob.hash !== mutation.baseHash) {
      throw new Error(
        `Dirty entry ${mutation.entryId} requires cached base blob ${mutation.baseBlobId}.`,
      );
    }
  }

  private inTransaction<T>(work: () => T): T {
    if (this.transactionDepth > 0) {
      return work();
    }

    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth += 1;
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  private prepare(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }

    return statement;
  }
}

interface SqlEntryRow {
  entry_id: string;
  remote_known: number;
  remote_path: string | null;
  remote_revision: number;
  remote_blob_id: string | null;
  remote_hash: string | null;
  remote_deleted: number;
  remote_updated_at: number;
  base_path: string | null;
  base_revision: number;
  base_blob_id: string | null;
  base_hash: string | null;
  base_deleted: number;
  local_known: number;
  local_path: string | null;
  local_blob_id: string | null;
  local_hash: string | null;
  local_deleted: number;
  local_updated_at: number;
  local_mtime: number | null;
  local_size: number | null;
  dirty: number;
  pending_mutation_id: string | null;
  pending_op: string | null;
  pending_status: string | null;
  pending_blocked_reason: string | null;
  pending_blocked_encrypted_size_bytes: number | null;
  pending_blocked_max_file_size_bytes: number | null;
  pending_base_revision: number | null;
  pending_base_blob_id: string | null;
  pending_base_hash: string | null;
  pending_blob_id: string | null;
  pending_hash: string | null;
  pending_encrypted_metadata: string | null;
  pending_created_at: number | null;
  remote_path_key: string | null;
  local_path_key: string | null;
}

function fromSqlRow(row: SqlEntryRow): EntryRecord {
  return {
    entryId: row.entry_id,
    remoteKnown: row.remote_known === 1,
    remotePath: row.remote_path,
    remoteRevision: row.remote_revision,
    remoteBlobId: row.remote_blob_id,
    remoteHash: row.remote_hash,
    remoteDeleted: row.remote_deleted === 1,
    remoteUpdatedAt: row.remote_updated_at,
    basePath: row.base_path,
    baseRevision: row.base_revision,
    baseBlobId: row.base_blob_id,
    baseHash: row.base_hash,
    baseDeleted: row.base_deleted === 1,
    localKnown: row.local_known === 1,
    localPath: row.local_path,
    localBlobId: row.local_blob_id,
    localHash: row.local_hash,
    localDeleted: row.local_deleted === 1,
    localUpdatedAt: row.local_updated_at,
    localMtime: row.local_mtime,
    localSize: row.local_size,
    dirty: row.dirty === 1,
    pendingMutationId: row.pending_mutation_id,
    pendingOp: row.pending_op as EntryRecord["pendingOp"],
    pendingStatus: row.pending_status as EntryRecord["pendingStatus"],
    pendingBlockedReason:
      row.pending_blocked_reason as EntryRecord["pendingBlockedReason"],
    pendingBlockedEncryptedSizeBytes: row.pending_blocked_encrypted_size_bytes,
    pendingBlockedMaxFileSizeBytes: row.pending_blocked_max_file_size_bytes,
    pendingBaseRevision: row.pending_base_revision,
    pendingBaseBlobId: row.pending_base_blob_id,
    pendingBaseHash: row.pending_base_hash,
    pendingBlobId: row.pending_blob_id,
    pendingHash: row.pending_hash,
    pendingEncryptedMetadata: row.pending_encrypted_metadata,
    pendingCreatedAt: row.pending_created_at,
    remotePathKey: row.remote_path_key,
    localPathKey: row.local_path_key,
  };
}

function toSqlValues(entry: EntryRecord): Array<string | number | null> {
  return [
    entry.entryId,
    entry.remoteKnown ? 1 : 0,
    entry.remotePath,
    entry.remoteRevision,
    entry.remoteBlobId,
    entry.remoteHash,
    entry.remoteDeleted ? 1 : 0,
    entry.remoteUpdatedAt,
    entry.basePath,
    entry.baseRevision,
    entry.baseBlobId,
    entry.baseHash,
    entry.baseDeleted ? 1 : 0,
    entry.localKnown ? 1 : 0,
    entry.localPath,
    entry.localBlobId,
    entry.localHash,
    entry.localDeleted ? 1 : 0,
    entry.localUpdatedAt,
    entry.localMtime,
    entry.localSize,
    entry.dirty ? 1 : 0,
    entry.pendingMutationId,
    entry.pendingOp,
    entry.pendingStatus,
    entry.pendingBlockedReason,
    entry.pendingBlockedEncryptedSizeBytes,
    entry.pendingBlockedMaxFileSizeBytes,
    entry.pendingBaseRevision,
    entry.pendingBaseBlobId,
    entry.pendingBaseHash,
    entry.pendingBlobId,
    entry.pendingHash,
    entry.pendingEncryptedMetadata,
    entry.pendingCreatedAt,
    entry.remotePathKey ?? null,
    entry.localPathKey ?? null,
  ];
}
