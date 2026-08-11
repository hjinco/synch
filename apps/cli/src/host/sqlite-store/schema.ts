export const SQLITE_STORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS metadata (
  id TEXT PRIMARY KEY CHECK (id = 'sync'),
  local_vault_id TEXT NOT NULL,
  remote_vault_id TEXT,
  last_pulled_cursor INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS entries (
  entry_id TEXT PRIMARY KEY,
  remote_known INTEGER NOT NULL,
  remote_path TEXT,
  remote_revision INTEGER NOT NULL,
  remote_blob_id TEXT,
  remote_hash TEXT,
  remote_deleted INTEGER NOT NULL,
  remote_updated_at INTEGER NOT NULL,
  base_path TEXT,
  base_revision INTEGER NOT NULL,
  base_blob_id TEXT,
  base_hash TEXT,
  base_deleted INTEGER NOT NULL,
  local_known INTEGER NOT NULL,
  local_path TEXT,
  local_blob_id TEXT,
  local_hash TEXT,
  local_deleted INTEGER NOT NULL,
  local_updated_at INTEGER NOT NULL,
  local_mtime INTEGER,
  local_size INTEGER,
  dirty INTEGER NOT NULL,
  pending_mutation_id TEXT,
  pending_op TEXT,
  pending_status TEXT,
  pending_blocked_reason TEXT,
  pending_blocked_encrypted_size_bytes INTEGER,
  pending_blocked_max_file_size_bytes INTEGER,
  pending_base_revision INTEGER,
  pending_base_blob_id TEXT,
  pending_base_hash TEXT,
  pending_blob_id TEXT,
  pending_hash TEXT,
  pending_encrypted_metadata TEXT,
  pending_created_at INTEGER,
  remote_path_key TEXT,
  local_path_key TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_remote_path_key
  ON entries (remote_path_key) WHERE remote_path_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_local_path_key
  ON entries (local_path_key) WHERE local_path_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entries_pending
  ON entries (pending_status, pending_created_at, entry_id)
  WHERE pending_status IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entries_pending_mutation_id
  ON entries (pending_mutation_id) WHERE pending_mutation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS blobs (
  blob_id TEXT PRIMARY KEY,
  hash TEXT,
  encrypted_bytes BLOB NOT NULL,
  role TEXT NOT NULL,
  ref_entry_id TEXT,
  cached_at INTEGER NOT NULL
);
`;
