import { afterEach, describe, expect, it, vi } from "vitest";

import { CoordinatorMaintenanceScheduler } from "./maintenance-scheduler";

type TestJob = {
	key: string;
	dueAt: number;
	retryCount: number;
	lastError: string | null;
	lastErrorAt: number | null;
	updatedAt: number;
};

describe("CoordinatorMaintenanceScheduler", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("buckets blob GC alarms to the next 30 minute boundary", async () => {
		const job: TestJob = {
			key: "blob_gc",
			dueAt: 0,
			retryCount: 0,
			lastError: null,
			lastErrorAt: null,
			updatedAt: 0,
		};
		const ctx = createTestDurableObjectState(job);
		const scheduler = new CoordinatorMaintenanceScheduler(ctx);

		await scheduler.defer("blob_gc", 30 * 60 * 1000 + 1, 1_000);

		expect(job).toMatchObject({
			dueAt: 60 * 60 * 1000,
			retryCount: 0,
			updatedAt: 1_000,
		});
		expect(ctx.storage.setAlarm).toHaveBeenCalledWith(60 * 60 * 1000);
	});

	it("does not reset the durable object alarm when it is already scheduled for the next job", async () => {
		const job: TestJob = {
			key: "health_summary_flush",
			dueAt: 10_000,
			retryCount: 0,
			lastError: null,
			lastErrorAt: null,
			updatedAt: 0,
		};
		const ctx = createTestDurableObjectState(job, 10_000);
		const scheduler = new CoordinatorMaintenanceScheduler(ctx);

		await scheduler.rearm();

		expect(ctx.storage.getAlarm).toHaveBeenCalled();
		expect(ctx.storage.setAlarm).not.toHaveBeenCalled();
	});

	it("skips deferring a job when an existing schedule is already sooner", async () => {
		const job: TestJob = {
			key: "health_summary_flush",
			dueAt: 10_000,
			retryCount: 0,
			lastError: null,
			lastErrorAt: null,
			updatedAt: 500,
		};
		const ctx = createTestDurableObjectState(job, 10_000);
		const scheduler = new CoordinatorMaintenanceScheduler(ctx);

		await scheduler.defer("health_summary_flush", 12_000, 1_000);

		expect(job).toMatchObject({
			dueAt: 10_000,
			updatedAt: 500,
		});
		expect(ctx.storage.setAlarm).not.toHaveBeenCalled();
		expect(ctx.storage.getAlarm).not.toHaveBeenCalled();
	});

	it("skips repeated blob GC defers within the same alarm bucket", async () => {
		const bucket = 60 * 60 * 1000;
		const job: TestJob = {
			key: "blob_gc",
			dueAt: bucket,
			retryCount: 0,
			lastError: null,
			lastErrorAt: null,
			updatedAt: 500,
		};
		const ctx = createTestDurableObjectState(job, bucket);
		const scheduler = new CoordinatorMaintenanceScheduler(ctx);

		await scheduler.defer("blob_gc", 45 * 60 * 1000, 1_000);

		expect(job).toMatchObject({
			dueAt: bucket,
			updatedAt: 500,
		});
		expect(ctx.storage.setAlarm).not.toHaveBeenCalled();
		expect(ctx.storage.getAlarm).not.toHaveBeenCalled();
	});

	it("logs failed maintenance jobs while preserving retry scheduling", async () => {
		const now = 1_000;
		const job: TestJob = {
			key: "blob_gc",
			dueAt: now - 1,
			retryCount: 1,
			lastError: null,
			lastErrorAt: null,
			updatedAt: now - 1,
		};
		const ctx = createTestDurableObjectState(job);
		const error = new Error("d1 unavailable");
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const scheduler = new CoordinatorMaintenanceScheduler(ctx);
		const handlers = {
			blob_gc: vi.fn(async () => {
				throw error;
			}),
			health_summary_flush: vi.fn(async () => null),
		};

		await scheduler.drain(handlers, now);

		expect(job).toMatchObject({
			dueAt: 61_000,
			retryCount: 2,
			lastError: "d1 unavailable",
			lastErrorAt: now,
			updatedAt: now,
		});
		expect(ctx.storage.setAlarm).toHaveBeenCalledWith(61_000);
		expect(consoleError).toHaveBeenCalledWith(
			"[sync-coordinator] maintenance job failed",
			expect.objectContaining({
				jobKey: "blob_gc",
				dueAt: now - 1,
				failedAt: now,
				retryCount: 2,
				nextDueAt: 61_000,
				error: expect.objectContaining({
					name: "Error",
					message: "d1 unavailable",
					stack: expect.any(String),
				}),
			}),
		);
	});

	it("reschedules a due job from the handler nextDueAt even when defer would no-op", async () => {
		const now = 61_000;
		const nextDueAt = now + 24 * 60 * 60 * 1000;
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
		const handlers = {
			blob_gc: vi.fn(async () => null),
			health_summary_flush: vi.fn(async () => {
				// Mirrors HealthSyncService: defer is a no-op while the overdue
				// job still exists; drain must persist nextDueAt via rescheduleJob.
				await scheduler.defer("health_summary_flush", nextDueAt, now);
				return nextDueAt;
			}),
		};

		await scheduler.drain(handlers, now);

		expect(deferSpy).toHaveBeenCalledWith("health_summary_flush", nextDueAt, now);
		expect(job).toMatchObject({
			key: "health_summary_flush",
			dueAt: nextDueAt,
			retryCount: 0,
			updatedAt: now,
		});
		expect(ctx.storage.setAlarm).toHaveBeenCalledWith(nextDueAt);
	});
});

function createTestDurableObjectState(
	job: TestJob,
	initialAlarm: number | null = null,
): DurableObjectState {
	let alarm = initialAlarm;
	const storage = {
		sql: {
			exec: vi.fn((query: string, ...params: unknown[]) => {
				if (query.includes("SELECT key, due_at, retry_count") && query.includes("WHERE key = ?")) {
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
