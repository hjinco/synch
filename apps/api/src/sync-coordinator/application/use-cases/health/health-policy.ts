import type { VaultSyncStatusSummary } from "../../dto/health";

const STAGED_BLOB_STALE_MS = 60 * 60 * 1000;
const PENDING_DELETE_STALE_MS = 24 * 60 * 60 * 1000;
const ACTIVE_WITHOUT_RECENT_COMMIT_MS = 24 * 60 * 60 * 1000;

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
		const commitWarningAt = summary.lastCommitAt + ACTIVE_WITHOUT_RECENT_COMMIT_MS;
		if (commitWarningAt > now) candidates.push(commitWarningAt);
	}
	const stagedWarningAt = futureDueFromAge(now, summary.oldestStagedBlobAgeMs, STAGED_BLOB_STALE_MS);
	if (stagedWarningAt !== null) candidates.push(stagedWarningAt);
	const pendingDeleteWarningAt = futureDueFromAge(
		now,
		summary.oldestPendingDeleteAgeMs,
		PENDING_DELETE_STALE_MS,
	);
	if (pendingDeleteWarningAt !== null) candidates.push(pendingDeleteWarningAt);
	return candidates.length === 0 ? null : Math.min(...candidates);
}

function futureDueFromAge(now: number, ageMs: number | null, thresholdMs: number): number | null {
	if (ageMs === null || ageMs >= thresholdMs) return null;
	return now + (thresholdMs - ageMs);
}
