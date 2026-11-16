import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	closeAllTestSqliteCoordinators,
	createSqliteCoordinator,
} from "../sqlite/test-helpers";
import type { CoordinatorStorageHandle } from "../sqlite/storage-handle";
import { CoordinatorMaintenanceScheduler } from "./maintenance-scheduler";
import { NodeMaintenanceScheduler } from "./node-maintenance-scheduler";

const cleanups: Array<() => void> = [];

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(1_000);
});

afterEach(() => {
	cleanups.splice(0).forEach((dispose) => dispose());
	closeAllTestSqliteCoordinators();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function createScheduler(runtime: "cloudflare" | "node", handle: CoordinatorStorageHandle) {
	if (runtime === "node") {
		const scheduler = new NodeMaintenanceScheduler(handle, async () => {});
		cleanups.push(() => scheduler.dispose());
		return { scheduler, armed: async () => vi.getTimerCount() > 0 };
	}
	let alarm: number | null = null;
	const scheduler = new CoordinatorMaintenanceScheduler({
		storage: {
			sql: handle,
			getAlarm: async () => alarm,
			setAlarm: async (at: number) => { alarm = at; },
			deleteAlarm: async () => { alarm = null; },
		},
	} as unknown as DurableObjectState);
	return { scheduler, armed: async () => alarm !== null };
}

describe.each(["cloudflare", "node"] as const)("%s durable maintenance", (runtime) => {
	it("keeps the earliest schedule, buckets GC, drains in order and clears its alarm", async () => {
		const { handle } = await createSqliteCoordinator();
		const { scheduler, armed } = createScheduler(runtime, handle);
		await scheduler.defer("blob_gc", 1_001);
		await scheduler.defer("health_summary_flush", 5_000);
		await scheduler.defer("health_summary_flush", 9_000);
		await scheduler.defer("health_summary_flush", 3_000);
		expect(handle.exec("SELECT key, due_at FROM maintenance_jobs ORDER BY due_at").toArray()).toEqual([
			{ key: "health_summary_flush", due_at: 3_000 },
			{ key: "blob_gc", due_at: 1_800_000 },
		]);
		expect(await armed()).toBe(true);
		const order: string[] = [];
		await scheduler.drain({
			blob_gc: async () => { order.push("gc"); return null; },
			health_summary_flush: async () => { order.push("health"); return null; },
		}, 1_800_000);
		expect(order).toEqual(["health", "gc"]);
		expect(handle.exec("SELECT * FROM maintenance_jobs").toArray()).toEqual([]);
		expect(await armed()).toBe(false);
	});

	it("persists exponential retries up to the cap and clears failures after success", async () => {
		const { handle } = await createSqliteCoordinator();
		const { scheduler } = createScheduler(runtime, handle);
		vi.spyOn(console, "error").mockImplementation(() => {});
		let now = 1_000;
		await scheduler.defer("health_summary_flush", now);
		const failure = new Error("storage unavailable");
		const handlers = {
			blob_gc: async () => null,
			health_summary_flush: vi.fn<() => Promise<number | null>>().mockRejectedValue(failure),
		};
		const delays = [30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000];
		for (const [index, delay] of delays.entries()) {
			await scheduler.drain(handlers, now);
			expect(handle.exec("SELECT * FROM maintenance_jobs").one()).toMatchObject({
				due_at: now + delay,
				retry_count: index + 1,
				last_error: failure.message,
				last_error_at: now,
			});
			now += delay;
		}
		handlers.health_summary_flush.mockResolvedValue(now + 10_000);
		await scheduler.drain(handlers, now);
		expect(handle.exec("SELECT * FROM maintenance_jobs").one()).toMatchObject({
			due_at: now + 10_000, retry_count: 0, last_error: null, last_error_at: null,
		});
	});

	it("bounds one drain when a handler keeps returning an already due time", async () => {
		const { handle } = await createSqliteCoordinator();
		const { scheduler, armed } = createScheduler(runtime, handle);
		await scheduler.defer("health_summary_flush", 1_000);
		const handler = vi.fn(async () => 1_000);
		await scheduler.drain({ blob_gc: async () => null, health_summary_flush: handler }, 1_000);
		expect(handler).toHaveBeenCalledTimes(16);
		expect(await armed()).toBe(true);
		expect(handle.exec("SELECT due_at FROM maintenance_jobs").one()).toEqual({ due_at: 1_000 });
	});

	it("recovers persisted jobs after the runtime loses its alarm", async () => {
		const { handle } = await createSqliteCoordinator();
		handle.exec("INSERT INTO maintenance_jobs (key, due_at, retry_count, updated_at) VALUES (?, ?, ?, ?)",
			"health_summary_flush", 5_000, 2, 1_000);
		const { scheduler, armed } = createScheduler(runtime, handle);
		expect(await armed()).toBe(false);
		await scheduler.ensureArmed();
		expect(await armed()).toBe(true);
		expect(handle.exec("SELECT retry_count FROM maintenance_jobs").one()).toEqual({ retry_count: 2 });
	});
});

it("keeps Node alarm retries earlier than jobs and disposes timers without losing work", async () => {
	const { handle } = await createSqliteCoordinator();
	const due = vi.fn(async () => {});
	const scheduler = new NodeMaintenanceScheduler(handle, due);
	cleanups.push(() => scheduler.dispose());
	await scheduler.defer("health_summary_flush", 10_000);
	scheduler.retryAfter(500);
	await scheduler.ensureArmed();
	await vi.advanceTimersByTimeAsync(500);
	expect(due).toHaveBeenCalledTimes(1);
	await scheduler.ensureArmed();
	expect(vi.getTimerCount()).toBe(1);
	scheduler.dispose();
	expect(vi.getTimerCount()).toBe(0);
	expect(handle.exec("SELECT due_at FROM maintenance_jobs").one()).toEqual({ due_at: 10_000 });
	const restarted = new NodeMaintenanceScheduler(handle, due);
	cleanups.push(() => restarted.dispose());
	await restarted.ensureArmed();
	await vi.advanceTimersByTimeAsync(8_500);
	expect(due).toHaveBeenCalledTimes(2);
	expect(vi.getTimerCount()).toBe(0);
});
