export type VaultSyncHealthStatus = "ok" | "warning" | "critical" | "unknown";

export type VaultHealthFacts = {
	storageUsedBytes: number;
	storageLimitBytes: number;
	oldestStagedBlobAgeMs: number | null;
	oldestPendingDeleteAgeMs: number | null;
	collectiblePendingDeleteBlobCount: number;
	activeLocalVaultCount: number;
	lastCommitAt: number | null;
};

export const STAGED_BLOB_STALE_MS = 60 * 60 * 1000;
export const PENDING_DELETE_STALE_MS = 24 * 60 * 60 * 1000;
export const ACTIVE_WITHOUT_RECENT_COMMIT_MS = 24 * 60 * 60 * 1000;
export const PENDING_DELETE_BACKLOG_WARNING_COUNT = 100;
const STORAGE_NEAR_LIMIT_RATIO = 0.8;

export function evaluateHealth(
	facts: VaultHealthFacts,
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
		facts.storageLimitBytes > 0 &&
		facts.storageUsedBytes >= facts.storageLimitBytes
	) {
		critical("storage_over_limit");
	} else if (
		facts.storageLimitBytes > 0 &&
		facts.storageUsedBytes >=
			Math.floor(facts.storageLimitBytes * STORAGE_NEAR_LIMIT_RATIO)
	) {
		warning("storage_near_limit");
	}

	if (
		facts.oldestStagedBlobAgeMs !== null &&
		facts.oldestStagedBlobAgeMs >= STAGED_BLOB_STALE_MS
	) {
		warning("staged_blob_stale");
	}

	if (
		facts.oldestPendingDeleteAgeMs !== null &&
		facts.oldestPendingDeleteAgeMs >= PENDING_DELETE_STALE_MS
	) {
		warning("pending_delete_stale");
	}

	if (
		facts.collectiblePendingDeleteBlobCount >
		PENDING_DELETE_BACKLOG_WARNING_COUNT
	) {
		warning("pending_delete_backlog");
	}

	if (
		facts.activeLocalVaultCount > 0 &&
		(facts.lastCommitAt === null ||
			now - facts.lastCommitAt >= ACTIVE_WITHOUT_RECENT_COMMIT_MS)
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
	facts: Pick<
		VaultHealthFacts,
		| "activeLocalVaultCount"
		| "lastCommitAt"
		| "oldestStagedBlobAgeMs"
		| "oldestPendingDeleteAgeMs"
	>,
	now: number,
): number | null {
	const candidates: number[] = [];

	if (facts.activeLocalVaultCount > 0 && facts.lastCommitAt !== null) {
		const commitWarningAt =
			facts.lastCommitAt + ACTIVE_WITHOUT_RECENT_COMMIT_MS;
		if (commitWarningAt > now) {
			candidates.push(commitWarningAt);
		}
	}

	const stagedWarningAt = futureDueFromAge(
		now,
		facts.oldestStagedBlobAgeMs,
		STAGED_BLOB_STALE_MS,
	);
	if (stagedWarningAt !== null) {
		candidates.push(stagedWarningAt);
	}

	const pendingDeleteWarningAt = futureDueFromAge(
		now,
		facts.oldestPendingDeleteAgeMs,
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
