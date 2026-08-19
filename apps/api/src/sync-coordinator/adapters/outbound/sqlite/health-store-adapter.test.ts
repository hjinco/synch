import { describe, expect, it } from "vitest";

import {
	ACTIVE_WITHOUT_RECENT_COMMIT_MS,
	PENDING_DELETE_STALE_MS,
	STAGED_BLOB_STALE_MS,
	nextHealthSummaryFlushAt,
} from "./health-store";

describe("nextHealthSummaryFlushAt", () => {
	it("schedules active_without_recent_commit at lastCommitAt + threshold", () => {
		const now = 10_000;
		const lastCommitAt = 1_000;

		expect(
			nextHealthSummaryFlushAt(
				{
					activeLocalVaultCount: 1,
					lastCommitAt,
					oldestStagedBlobAgeMs: null,
					oldestPendingDeleteAgeMs: null,
				},
				now,
			),
		).toBe(lastCommitAt + ACTIVE_WITHOUT_RECENT_COMMIT_MS);
	});

	it("does not reschedule once active_without_recent_commit is already due", () => {
		const lastCommitAt = 1_000;
		const now = lastCommitAt + ACTIVE_WITHOUT_RECENT_COMMIT_MS;

		expect(
			nextHealthSummaryFlushAt(
				{
					activeLocalVaultCount: 1,
					lastCommitAt,
					oldestStagedBlobAgeMs: null,
					oldestPendingDeleteAgeMs: null,
				},
				now,
			),
		).toBeNull();
	});

	it("skips commit deadline when there are no active local vaults", () => {
		expect(
			nextHealthSummaryFlushAt(
				{
					activeLocalVaultCount: 0,
					lastCommitAt: 1_000,
					oldestStagedBlobAgeMs: null,
					oldestPendingDeleteAgeMs: null,
				},
				10_000,
			),
		).toBeNull();
	});

	it("picks the earliest upcoming time-based threshold", () => {
		const now = 10_000;
		const stagedDueIn = 5 * 60 * 1000;

		expect(
			nextHealthSummaryFlushAt(
				{
					activeLocalVaultCount: 1,
					lastCommitAt: now,
					oldestStagedBlobAgeMs: STAGED_BLOB_STALE_MS - stagedDueIn,
					oldestPendingDeleteAgeMs: PENDING_DELETE_STALE_MS - 60 * 60 * 1000,
				},
				now,
			),
		).toBe(now + stagedDueIn);
	});

	it("does not schedule already-stale blob ages again", () => {
		expect(
			nextHealthSummaryFlushAt(
				{
					activeLocalVaultCount: 0,
					lastCommitAt: null,
					oldestStagedBlobAgeMs: STAGED_BLOB_STALE_MS,
					oldestPendingDeleteAgeMs: PENDING_DELETE_STALE_MS,
				},
				10_000,
			),
		).toBeNull();
	});
});
