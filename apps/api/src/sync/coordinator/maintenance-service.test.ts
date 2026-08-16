import { afterEach, describe, expect, it, vi } from "vitest";

import { HealthSyncService } from "./health/sync-service";
import { CoordinatorMaintenanceScheduler } from "./maintenance-scheduler";
import { CoordinatorMaintenanceService } from "./maintenance-service";
import { ACTIVE_WITHOUT_RECENT_COMMIT_MS } from "./store/health-store";
import type { HealthStateStore } from "./ports";
import type { VaultSyncStatusSummary } from "../health/types";

type TestJob = {
	key: string;
	dueAt: number;
	retryCount: number;
	lastError: string | null;
	lastErrorAt: number | null;
	updatedAt: number;
};

describe("CoordinatorMaintenanceService health flush drain", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("persists the next health deadline via drain when defer cannot move an overdue job", async () => {
		const lastCommitAt = 1_000;
		const now = 61_000;
		const nextDueAt = lastCommitAt + ACTIVE_WITHOUT_RECENT_COMMIT_MS;
		const job: TestJob = {
			key: "health_summary_flush",
			dueAt: now - 1,
			retryCount: 0,
			lastError: null,
			lastErrorAt: null,
			updatedAt: now - 1,
		};
		const ctx = createTestDurableObjectState(job);
		const scheduler = new CoordinatorMaintenanceScheduler(ctx);
		const deferSpy = vi.spyOn(scheduler, "defer");
		const healthSyncService = new HealthSyncService(
			createStateRepository({
				readHealthSummary: vi.fn(() => createSummary({ lastCommitAt })),
			}),
			{ upsert: vi.fn(async () => {}) },
			30 * 24 * 60 * 60 * 1000,
			scheduler,
		);
		const maintenanceService = new CoordinatorMaintenanceService(
			scheduler,
			{ runGc: vi.fn(async () => null) },
			healthSyncService,
			{ isPurged: () => false },
		);

		// Drain uses Date.now() internally; freeze it to the overdue flush instant.
		vi.spyOn(Date, "now").mockReturnValue(now);
		await maintenanceService.handleAlarm();

		expect(deferSpy).toHaveBeenCalledWith(
			"health_summary_flush",
			nextDueAt,
			now,
		);
		// Overdue job makes defer a no-op; the returned nextDueAt must reschedule.
		expect(job).toMatchObject({
			key: "health_summary_flush",
			dueAt: nextDueAt,
			retryCount: 0,
		});
		expect(ctx.storage.setAlarm).toHaveBeenCalledWith(nextDueAt);
	});

	it("deletes the health flush job when no future deadline remains", async () => {
		const lastCommitAt = 1_000;
		const now = lastCommitAt + ACTIVE_WITHOUT_RECENT_COMMIT_MS;
		const job: TestJob = {
			key: "health_summary_flush",
			dueAt: now - 1,
			retryCount: 0,
			lastError: null,
			lastErrorAt: null,
			updatedAt: now - 1,
		};
		const ctx = createTestDurableObjectState(job);
		const scheduler = new CoordinatorMaintenanceScheduler(ctx);
		const healthSyncService = new HealthSyncService(
			createStateRepository({
				readHealthSummary: vi.fn(() =>
					createSummary({
						lastCommitAt,
						healthStatus: "warning",
						healthReasons: ["active_without_recent_commit"],
					}),
				),
			}),
			{ upsert: vi.fn(async () => {}) },
			30 * 24 * 60 * 60 * 1000,
			scheduler,
		);
		const maintenanceService = new CoordinatorMaintenanceService(
			scheduler,
			{ runGc: vi.fn(async () => null) },
			healthSyncService,
			{ isPurged: () => false },
		);

		vi.spyOn(Date, "now").mockReturnValue(now);
		await maintenanceService.handleAlarm();

		expect(job.dueAt).toBe(0);
		expect(ctx.storage.deleteAlarm).toHaveBeenCalled();
	});
});

function createSummary(
	overrides: Partial<VaultSyncStatusSummary> = {},
): VaultSyncStatusSummary {
	return {
		vaultId: "vault-1",
		healthStatus: "ok",
		healthReasons: [],
		currentCursor: 1,
		entryCount: 1,
		liveBlobCount: 1,
		stagedBlobCount: 0,
		pendingDeleteBlobCount: 0,
		storageUsedBytes: 10,
		storageLimitBytes: 100,
		activeLocalVaultCount: 1,
		websocketCount: 1,
		oldestStagedBlobAgeMs: null,
		oldestPendingDeleteAgeMs: null,
		lastCommitAt: 1_000,
		lastGcAt: null,
		...overrides,
	};
}

function createStateRepository(
	overrides: Partial<HealthStateStore> = {},
): HealthStateStore {
	return {
		recordGcCompleted: vi.fn(),
		readHealthSummary: vi.fn(() => null),
		readStorageStatus: vi.fn(() => ({
			storageUsedBytes: 0,
			storageLimitBytes: 100,
		})),
		...overrides,
	};
}

function createTestDurableObjectState(job: TestJob): DurableObjectState {
	let alarm: number | null = job.dueAt === 0 ? null : job.dueAt;
	const storage = {
		sql: {
			exec: vi.fn((query: string, ...params: unknown[]) => {
				if (
					query.includes("SELECT key, due_at, retry_count") &&
					query.includes("WHERE key = ?")
				) {
					return {
						toArray: () =>
							job.dueAt === 0 || job.key !== params[0]
								? []
								: [
										{
											key: job.key,
											due_at: job.dueAt,
											retry_count: job.retryCount,
										},
									],
					};
				}

				if (query.includes("INSERT INTO maintenance_jobs")) {
					job.key = String(params[0]);
					if (query.includes("due_at = min(")) {
						job.dueAt =
							job.dueAt === 0
								? Number(params[1])
								: Math.min(job.dueAt, Number(params[1]));
					} else {
						job.dueAt = Number(params[1]);
						job.lastError = null;
						job.lastErrorAt = null;
					}
					job.retryCount = 0;
					job.updatedAt = Number(params[2]);
					return { toArray: () => [] };
				}

				if (query.includes("WHERE due_at <= ?")) {
					return {
						toArray: () =>
							job.dueAt === 0 || job.dueAt > Number(params[0])
								? []
								: [
										{
											key: job.key,
											due_at: job.dueAt,
											retry_count: job.retryCount,
										},
									],
					};
				}

				if (query.includes("DELETE FROM maintenance_jobs")) {
					if (job.key === params[0]) {
						job.dueAt = 0;
						job.retryCount = 0;
						job.lastError = null;
						job.lastErrorAt = null;
					}
					return { toArray: () => [] };
				}

				if (query.includes("SELECT due_at")) {
					return {
						toArray: () => (job.dueAt === 0 ? [] : [{ due_at: job.dueAt }]),
					};
				}

				if (query.includes("UPDATE maintenance_jobs")) {
					job.dueAt = Number(params[0]);
					job.retryCount = Number(params[1]);
					job.lastError = String(params[2]);
					job.lastErrorAt = Number(params[3]);
					job.updatedAt = Number(params[4]);
					return { toArray: () => [] };
				}

				throw new Error(`unexpected query: ${query}`);
			}),
		},
		setAlarm: vi.fn(async (scheduledTime: number) => {
			alarm = scheduledTime;
		}),
		deleteAlarm: vi.fn(async () => {
			alarm = null;
		}),
		getAlarm: vi.fn(async () => alarm),
	};

	return { storage } as unknown as DurableObjectState;
}
