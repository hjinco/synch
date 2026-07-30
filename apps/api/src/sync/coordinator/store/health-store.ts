import type { StorageStatusSnapshot } from "../types";
import type {
	VaultSyncHealthStatus,
	VaultSyncStatusSummary,
} from "../../health/types";
import type { CoordinatorStorageHandle } from "./storage-handle";

export const STAGED_BLOB_STALE_MS = 60 * 60 * 1000;
export const PENDING_DELETE_STALE_MS = 24 * 60 * 60 * 1000;
export const ACTIVE_WITHOUT_RECENT_COMMIT_MS = 24 * 60 * 60 * 1000;
const PENDING_DELETE_BACKLOG_WARNING_COUNT = 100;
const STORAGE_NEAR_LIMIT_RATIO = 0.8;

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

	recordHealthSummaryFlushed(now = Date.now()): void {
		this.handle.exec(
			`
			UPDATE coordinator_state
			SET last_health_flushed_at = ?,
				health_flush_retry_count = 0,
				last_health_flush_error = NULL,
				last_health_flush_error_at = NULL
			WHERE id = 1
			`,
			now,
		);
	}

	recordHealthSummaryFlushFailed(error: unknown, now = Date.now()): number {
		this.handle.exec(
			`
			UPDATE coordinator_state
			SET health_flush_retry_count = health_flush_retry_count + 1,
				last_health_flush_error = ?,
				last_health_flush_error_at = ?
			WHERE id = 1
			`,
			formatCompactError(error),
			now,
		);
		const row = this.handle
			.exec<{ health_flush_retry_count: number }>(
				"SELECT health_flush_retry_count FROM coordinator_state WHERE id = 1",
			)
			.toArray()[0];
		return Number(row?.health_flush_retry_count ?? 1);
	}

	readHealthSummary(
		now: number,
		activeCursorTtlMs: number,
	): VaultSyncStatusSummary | null {
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
					(SELECT min(created_at) FROM blobs WHERE state = 'staged') AS oldest_staged_blob_at,
					(SELECT min(delete_after) FROM blobs WHERE state = 'pending_delete') AS oldest_pending_delete_at,
					(SELECT count(*) FROM local_vault_connections WHERE last_connected_at >= ?) AS active_local_vault_count
				`,
				activeSince,
			)
			.toArray()[0];

		const summary = {
			vaultId: state.vault_id,
			healthStatus: "unknown",
			healthReasons: [],
			currentCursor: Number(state.current_cursor),
			entryCount: Number(stats?.entry_count ?? 0),
			liveBlobCount: Number(stats?.live_blob_count ?? 0),
			stagedBlobCount: Number(stats?.staged_blob_count ?? 0),
			pendingDeleteBlobCount: Number(stats?.pending_delete_blob_count ?? 0),
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
		} satisfies VaultSyncStatusSummary;
		const evaluated = evaluateHealth(summary, now);

		return {
			...summary,
			healthStatus: evaluated.status,
			healthReasons: evaluated.reasons,
		};
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

function evaluateHealth(
	summary: VaultSyncStatusSummary,
	now: number,
): { status: VaultSyncHealthStatus; reasons: string[] } {
	const reasons: string[] = [];
	let status: VaultSyncHealthStatus = "ok";

	const warning = (reason: string) => {
		if (status === "ok") {
			status = "warning";
		}
		reasons.push(reason);
	};
	const critical = (reason: string) => {
		status = "critical";
		reasons.push(reason);
	};

	if (
		summary.storageLimitBytes > 0 &&
		summary.storageUsedBytes >= summary.storageLimitBytes
	) {
		critical("storage_over_limit");
	} else if (
		summary.storageLimitBytes > 0 &&
		summary.storageUsedBytes >=
			Math.floor(summary.storageLimitBytes * STORAGE_NEAR_LIMIT_RATIO)
	) {
		warning("storage_near_limit");
	}

	if (
		summary.oldestStagedBlobAgeMs !== null &&
		summary.oldestStagedBlobAgeMs >= STAGED_BLOB_STALE_MS
	) {
		warning("staged_blob_stale");
	}

	if (
		summary.oldestPendingDeleteAgeMs !== null &&
		summary.oldestPendingDeleteAgeMs >= PENDING_DELETE_STALE_MS
	) {
		warning("pending_delete_stale");
	}

	if (summary.pendingDeleteBlobCount > PENDING_DELETE_BACKLOG_WARNING_COUNT) {
		warning("pending_delete_backlog");
	}

	if (
		summary.activeLocalVaultCount > 0 &&
		(summary.lastCommitAt === null ||
			now - summary.lastCommitAt >= ACTIVE_WITHOUT_RECENT_COMMIT_MS)
	) {
		warning("active_without_recent_commit");
	}

	return { status, reasons };
}

/**
 * Earliest future time when a time-based health reason can change.
 * Already-fired thresholds are skipped so flushes do not reschedule forever.
 */
export function nextHealthSummaryFlushAt(
	summary: Pick<
		VaultSyncStatusSummary,
		| "activeLocalVaultCount"
		| "lastCommitAt"
		| "oldestStagedBlobAgeMs"
		| "oldestPendingDeleteAgeMs"
	>,
	now: number,
): number | null {
	const candidates: number[] = [];

	if (summary.activeLocalVaultCount > 0 && summary.lastCommitAt !== null) {
		const commitWarningAt =
			summary.lastCommitAt + ACTIVE_WITHOUT_RECENT_COMMIT_MS;
		if (commitWarningAt > now) {
			candidates.push(commitWarningAt);
		}
	}

	const stagedWarningAt = futureDueFromAge(
		now,
		summary.oldestStagedBlobAgeMs,
		STAGED_BLOB_STALE_MS,
	);
	if (stagedWarningAt !== null) {
		candidates.push(stagedWarningAt);
	}

	const pendingDeleteWarningAt = futureDueFromAge(
		now,
		summary.oldestPendingDeleteAgeMs,
		PENDING_DELETE_STALE_MS,
	);
	if (pendingDeleteWarningAt !== null) {
		candidates.push(pendingDeleteWarningAt);
	}

	if (candidates.length === 0) {
		return null;
	}
	return Math.min(...candidates);
}

function futureDueFromAge(
	now: number,
	ageMs: number | null,
	thresholdMs: number,
): number | null {
	if (ageMs === null || ageMs >= thresholdMs) {
		return null;
	}
	return now + (thresholdMs - ageMs);
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

function formatCompactError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.slice(0, 500);
}
