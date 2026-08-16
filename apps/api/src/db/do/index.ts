import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const entries = sqliteTable(
	"entries",
	{
		entryId: text("entry_id").primaryKey(),
		revision: integer("revision").notNull(),
		blobId: text("blob_id"),
		encryptedMetadata: text("encrypted_metadata").notNull(),
		deleted: integer("deleted").notNull().default(0),
		updatedSeq: integer("updated_seq").notNull(),
		updatedAt: integer("updated_at").notNull(),
		updatedByUserId: text("updated_by_user_id").notNull(),
		updatedByLocalVaultId: text("updated_by_local_vault_id").notNull(),
		lastMutationId: text("last_mutation_id"),
	},
	(table) => ({
		updatedSeqEntryIdIndex: index("idx_entries_updated_seq_entry_id").on(
			table.updatedSeq,
			table.entryId,
		),
		blobIdIndex: index("idx_entries_blob_id").on(table.blobId),
	}),
);

export const entryVersions = sqliteTable(
	"entry_versions",
	{
		versionId: text("version_id").primaryKey(),
		entryId: text("entry_id").notNull(),
		sourceRevision: integer("source_revision").notNull(),
		opType: text("op_type").notNull(),
		blobId: text("blob_id"),
		encryptedMetadata: text("encrypted_metadata").notNull(),
		reason: text("reason").notNull(),
		bucketStartMs: integer("bucket_start_ms"),
		capturedAt: integer("captured_at").notNull(),
		expiresAt: integer("expires_at").notNull(),
		createdByUserId: text("created_by_user_id").notNull(),
		createdByLocalVaultId: text("created_by_local_vault_id").notNull(),
	},
	(table) => ({
		entryCapturedAtIndex: index("idx_entry_versions_entry_captured_at").on(
			table.entryId,
			table.capturedAt,
			table.versionId,
		),
		autoBucketUnique: uniqueIndex("idx_entry_versions_auto_bucket").on(
			table.entryId,
			table.reason,
			table.bucketStartMs,
		),
		expiresAtIndex: index("idx_entry_versions_expires_at").on(table.expiresAt),
		blobExpiresAtIndex: index("idx_entry_versions_blob_expires_at").on(
			table.blobId,
			table.expiresAt,
		),
	}),
);

export const blobs = sqliteTable(
	"blobs",
	{
		blobId: text("blob_id").primaryKey(),
		state: text("state").notNull(),
		sizeBytes: integer("size_bytes").notNull().default(0),
		createdAt: integer("created_at").notNull(),
		lastUploadedAt: integer("last_uploaded_at").notNull(),
		deleteAfter: integer("delete_after"),
	},
	(table) => ({
		stateDeleteAfterIndex: index("idx_blobs_state_delete_after").on(
			table.state,
			table.deleteAfter,
		),
	}),
);

export const coordinatorState = sqliteTable("coordinator_state", {
	id: integer("id").primaryKey(),
	vaultId: text("vault_id").notNull(),
	currentCursor: integer("current_cursor").notNull().default(0),
	storageUsedBytes: integer("storage_used_bytes").notNull().default(0),
	storageLimitBytes: integer("storage_limit_bytes").notNull(),
	maxFileSizeBytes: integer("max_file_size_bytes").notNull(),
	versionHistoryRetentionDays: integer("version_history_retention_days")
		.notNull()
		.default(1),
	lastCommitAt: integer("last_commit_at"),
	lastGcAt: integer("last_gc_at"),
	syncPausedAt: integer("sync_paused_at"),
	syncPauseReason: text("sync_pause_reason"),
});

export const maintenanceJobs = sqliteTable(
	"maintenance_jobs",
	{
		key: text("key").primaryKey(),
		dueAt: integer("due_at").notNull(),
		retryCount: integer("retry_count").notNull().default(0),
		lastError: text("last_error"),
		lastErrorAt: integer("last_error_at"),
		updatedAt: integer("updated_at").notNull(),
	},
	(table) => ({
		dueAtIndex: index("idx_maintenance_jobs_due_at").on(table.dueAt),
	}),
);

export const localVaultConnections = sqliteTable(
	"local_vault_connections",
	{
		userId: text("user_id").notNull(),
		localVaultId: text("local_vault_id").notNull(),
		lastConnectedAt: integer("last_connected_at").notNull(),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.userId, table.localVaultId] }),
	}),
);
