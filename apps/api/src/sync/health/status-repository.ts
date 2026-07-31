import { sql } from "drizzle-orm";

import type { AppDb } from "../../db/client";
import type { VaultSyncStatusSummary } from "./types";

export class VaultSyncStatusRepository {
	constructor(private readonly db: AppDb) {}

	async upsert(summary: VaultSyncStatusSummary, flushedAt: number): Promise<void> {
		await this.db.run(sql`
			INSERT INTO vault_sync_status (
				vault_id,
				health_status,
				health_reasons_json,
				current_cursor,
				entry_count,
				live_blob_count,
				staged_blob_count,
				pending_delete_blob_count,
				storage_used_bytes,
				storage_limit_bytes,
				active_local_vault_count,
				websocket_count,
				oldest_staged_blob_age_ms,
				oldest_pending_delete_age_ms,
				last_commit_at,
				last_gc_at,
				last_flushed_at,
				last_flush_error,
				last_flush_error_at,
				created_at,
				updated_at
			)
			VALUES (
				${summary.vaultId},
				${summary.healthStatus},
				${JSON.stringify(summary.healthReasons)},
				${summary.currentCursor},
				${summary.entryCount},
				${summary.liveBlobCount},
				${summary.stagedBlobCount},
				${summary.pendingDeleteBlobCount},
				${summary.storageUsedBytes},
				${summary.storageLimitBytes},
				${summary.activeLocalVaultCount},
				${summary.websocketCount},
				${summary.oldestStagedBlobAgeMs},
				${summary.oldestPendingDeleteAgeMs},
				${summary.lastCommitAt},
				${summary.lastGcAt},
				${flushedAt},
				NULL,
				NULL,
				${flushedAt},
				${flushedAt}
			)
			ON CONFLICT(vault_id) DO UPDATE SET
				health_status = excluded.health_status,
				health_reasons_json = excluded.health_reasons_json,
				current_cursor = excluded.current_cursor,
				entry_count = excluded.entry_count,
				live_blob_count = excluded.live_blob_count,
				staged_blob_count = excluded.staged_blob_count,
				pending_delete_blob_count = excluded.pending_delete_blob_count,
				storage_used_bytes = excluded.storage_used_bytes,
				storage_limit_bytes = excluded.storage_limit_bytes,
				active_local_vault_count = excluded.active_local_vault_count,
				websocket_count = excluded.websocket_count,
				oldest_staged_blob_age_ms = excluded.oldest_staged_blob_age_ms,
				oldest_pending_delete_age_ms = excluded.oldest_pending_delete_age_ms,
				last_commit_at = excluded.last_commit_at,
				last_gc_at = excluded.last_gc_at,
				last_flushed_at = excluded.last_flushed_at,
				last_flush_error = NULL,
				last_flush_error_at = NULL,
				updated_at = excluded.updated_at
		`);
	}
}
