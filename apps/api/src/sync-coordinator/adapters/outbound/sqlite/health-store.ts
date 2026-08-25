import type { StorageStatusSnapshot } from "../../../application/dto/types";
import type { VaultHealthSnapshot } from "../../../application/ports/outbound";
import { COLLECTIBLE_PENDING_DELETE_SQL } from "./blob-collectability";
import type { CoordinatorStorageHandle } from "./storage-handle";

/** Live websocket count, kept separate from storage since it isn't backed by SQL. */
export interface CoordinatorSocketCounter {
	count(): number;
}

export class CoordinatorHealthStore {
	constructor(
		private readonly handle: CoordinatorStorageHandle,
		private readonly sockets: CoordinatorSocketCounter,
	) {}

	recordGcCompleted(now = Date.now()): void {
		this.handle.exec(
			`
			UPDATE coordinator_state
			SET last_gc_at = ?
			WHERE id = 1
			`,
			now,
		);
	}

	readHealthSnapshot(
		now: number,
		activeCursorTtlMs: number,
	): VaultHealthSnapshot | null {
		const state = this.handle
			.exec<{
				vault_id: string;
				current_cursor: number;
				storage_used_bytes: number;
				storage_limit_bytes: number;
				last_commit_at: number | null;
				last_gc_at: number | null;
			}>(
				`
				SELECT
					vault_id,
					current_cursor,
					storage_used_bytes,
					storage_limit_bytes,
					last_commit_at,
					last_gc_at
				FROM coordinator_state
				WHERE id = 1
				`,
			)
			.toArray()[0];
		if (!state) {
			return null;
		}

		const activeSince = now - activeCursorTtlMs;
		const stats = this.handle
			.exec<{
				entry_count: number;
				live_blob_count: number;
				staged_blob_count: number;
				pending_delete_blob_count: number;
				collectible_pending_delete_blob_count: number;
				oldest_staged_blob_at: number | null;
				oldest_pending_delete_at: number | null;
				active_local_vault_count: number;
			}>(
				`
				SELECT
					(SELECT count(*) FROM entries WHERE deleted = 0) AS entry_count,
					(SELECT count(*) FROM blobs WHERE state = 'live') AS live_blob_count,
					(SELECT count(*) FROM blobs WHERE state = 'staged') AS staged_blob_count,
					(SELECT count(*) FROM blobs WHERE state = 'pending_delete') AS pending_delete_blob_count,
					(SELECT count(*) FROM blobs WHERE ${COLLECTIBLE_PENDING_DELETE_SQL}) AS collectible_pending_delete_blob_count,
					(SELECT min(created_at) FROM blobs WHERE state = 'staged') AS oldest_staged_blob_at,
					(SELECT min(delete_after) FROM blobs WHERE ${COLLECTIBLE_PENDING_DELETE_SQL}) AS oldest_pending_delete_at,
					(SELECT count(*) FROM local_vault_connections WHERE last_connected_at >= ?) AS active_local_vault_count
				`,
				now,
				now,
				now,
				now,
				activeSince,
			)
			.toArray()[0];

		const snapshot = {
			vaultId: state.vault_id,
			currentCursor: Number(state.current_cursor),
			entryCount: Number(stats?.entry_count ?? 0),
			liveBlobCount: Number(stats?.live_blob_count ?? 0),
			stagedBlobCount: Number(stats?.staged_blob_count ?? 0),
			pendingDeleteBlobCount: Number(stats?.pending_delete_blob_count ?? 0),
			collectiblePendingDeleteBlobCount: Number(
				stats?.collectible_pending_delete_blob_count ?? 0,
			),
			storageUsedBytes: Number(state.storage_used_bytes),
			storageLimitBytes: Number(state.storage_limit_bytes),
			activeLocalVaultCount: Number(stats?.active_local_vault_count ?? 0),
			websocketCount: this.sockets.count(),
			oldestStagedBlobAgeMs: ageMs(now, stats?.oldest_staged_blob_at ?? null),
			oldestPendingDeleteAgeMs: ageMs(
				now,
				stats?.oldest_pending_delete_at ?? null,
			),
			lastCommitAt: nullableNumber(state.last_commit_at),
			lastGcAt: nullableNumber(state.last_gc_at),
		} satisfies VaultHealthSnapshot;

		return snapshot;
	}

	readStorageStatus(): StorageStatusSnapshot {
		const state = this.handle
			.exec<{
				storage_used_bytes: number;
				storage_limit_bytes: number;
			}>(
				`
				SELECT storage_used_bytes, storage_limit_bytes
				FROM coordinator_state
				WHERE id = 1
				`,
			)
			.toArray()[0];
		return {
			storageUsedBytes: Number(state?.storage_used_bytes ?? 0),
			storageLimitBytes: Number(state?.storage_limit_bytes ?? 0),
		};
	}
}

function nullableNumber(value: number | null): number | null {
	return value === null ? null : Number(value);
}

function ageMs(now: number, timestamp: number | null): number | null {
	if (timestamp === null) {
		return null;
	}
	return Math.max(0, now - Number(timestamp));
}
