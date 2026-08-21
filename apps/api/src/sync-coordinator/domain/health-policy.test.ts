import { describe, expect, it } from "vitest";

import {
	ACTIVE_WITHOUT_RECENT_COMMIT_MS,
	evaluateHealth,
	nextHealthSummaryFlushAt,
	PENDING_DELETE_BACKLOG_WARNING_COUNT,
	PENDING_DELETE_STALE_MS,
	STAGED_BLOB_STALE_MS,
	type VaultHealthFacts,
} from "./health-policy";

describe("evaluateHealth", () => {
	it("warns pending_delete_backlog only for collectible blobs", () => {
		expect(
			evaluateHealth(
				createFacts({
					collectiblePendingDeleteBlobCount:
						PENDING_DELETE_BACKLOG_WARNING_COUNT + 1,
				}),
				10_000,
			),
		).toEqual({
			status: "warning",
			reasons: ["pending_delete_backlog"],
		});
	});

	it("does not treat version-held pending_delete census as a backlog", () => {
		expect(
			evaluateHealth(
				createFacts({
					collectiblePendingDeleteBlobCount: 0,
					oldestPendingDeleteAgeMs: null,
				}),
				10_000,
			),
		).toEqual({
			status: "ok",
			reasons: [],
		});
	});

	it("warns pending_delete_stale from collectible age", () => {
		expect(
			evaluateHealth(
				createFacts({
					collectiblePendingDeleteBlobCount: 1,
					oldestPendingDeleteAgeMs: PENDING_DELETE_STALE_MS,
				}),
				10_000,
			),
		).toEqual({
			status: "warning",
			reasons: ["pending_delete_stale"],
		});
	});

	it("does not warn pending_delete_stale when only pinned blobs remain", () => {
		expect(
			evaluateHealth(
				createFacts({
					collectiblePendingDeleteBlobCount: 0,
					oldestPendingDeleteAgeMs: null,
				}),
				10_000,
			),
		).toEqual({
			status: "ok",
			reasons: [],
		});
	});
});

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

function createFacts(overrides: Partial<VaultHealthFacts> = {}): VaultHealthFacts {
	return {
		storageUsedBytes: 10,
		storageLimitBytes: 100,
		oldestStagedBlobAgeMs: null,
		oldestPendingDeleteAgeMs: null,
		collectiblePendingDeleteBlobCount: 0,
		activeLocalVaultCount: 0,
		lastCommitAt: null,
		...overrides,
	};
}
