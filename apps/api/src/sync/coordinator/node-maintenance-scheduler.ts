import type {
	MaintenanceJobHandlers,
	MaintenanceJobKey,
	MaintenanceRunner,
	MaintenanceScheduler,
} from "./maintenance-scheduler";
import type { CoordinatorStorageHandle } from "./store/storage-handle";

const MAX_DRAINED_JOBS_PER_ALARM = 16;
const MAINTENANCE_RETRY_MIN_MS = 30 * 1000;
const MAINTENANCE_RETRY_MAX_MS = 15 * 60 * 1000;
const BLOB_GC_ALARM_BUCKET_MS = 30 * 60 * 1000;

type MaintenanceJob = {
	key: MaintenanceJobKey;
	dueAt: number;
	retryCount: number;
};

/**
 * Node equivalent of `CoordinatorMaintenanceScheduler`: same `maintenance_jobs`
 * table and scheduling logic (via the portable `CoordinatorStorageHandle`
 * rather than DO's raw `ctx.storage.sql`), but a single in-memory `setTimeout`
 * in place of `ctx.storage.setAlarm`/`getAlarm`/`deleteAlarm` and the
 * platform-invoked `alarm()` DO lifecycle callback. There's one instance of
 * this per vault (matching one DO instance per vault), so the timer is armed
 * for at most one job at a time, same as the DO version.
 */
export class NodeMaintenanceScheduler implements MaintenanceScheduler, MaintenanceRunner {
	private timer: NodeJS.Timeout | null = null;
	private armedFor: number | null = null;

	constructor(
		private readonly handle: CoordinatorStorageHandle,
		private readonly onAlarmDue: () => Promise<void>,
	) {}

	async defer(key: MaintenanceJobKey, dueAt: number, now = Date.now()): Promise<void> {
		const scheduledDueAt = maintenanceJobDueAt(key, dueAt);
		const existing = this.readJob(key);
		if (existing && existing.dueAt <= scheduledDueAt) {
			return;
		}

		this.handle.exec(
			`
			INSERT INTO maintenance_jobs (key, due_at, retry_count, updated_at)
			VALUES (?, ?, 0, ?)
			ON CONFLICT(key) DO UPDATE SET
				due_at = min(maintenance_jobs.due_at, excluded.due_at),
				updated_at = excluded.updated_at
			`,
			key,
			scheduledDueAt,
			now,
		);
		this.rearm();
	}

	async drain(handlers: MaintenanceJobHandlers, now = Date.now()): Promise<void> {
		for (let i = 0; i < MAX_DRAINED_JOBS_PER_ALARM; i += 1) {
			const job = this.readNextDueJob(now);
			if (!job) {
				break;
			}

			try {
				const nextDueAt = await handlers[job.key](now);
				if (nextDueAt === null) {
					this.deleteJob(job.key);
				} else {
					this.rescheduleJob(job.key, nextDueAt, now);
				}
			} catch (error) {
				const failedJob = this.rescheduleFailedJob(job, error, now);
				logMaintenanceJobError(job, failedJob, error, now);
			}
		}

		this.rearm();
	}

	/** Arms the timer if a job is due and nothing is armed earlier already; mirrors `ensureArmed()` used once at DO cold start. */
	ensureArmed(): void {
		const next = this.readNextDueAt();
		if (next === null) {
			return;
		}
		if (this.armedFor === null || this.armedFor > next) {
			this.arm(next);
		}
	}

	/** Arms a bare retry timer `delayMs` from now, bypassing the job table - mirrors the DO alarm's `ctx.storage.setAlarm(retryAt)` retry-after-failure path, which is independent of any individual maintenance job's own due date. */
	retryAfter(delayMs: number): void {
		this.arm(Date.now() + delayMs);
	}

	/** Releases the timer; call on shutdown so it doesn't outlive the vault runtime. */
	dispose(): void {
		if (this.timer) {
			clearTimeout(this.timer);
		}
		this.timer = null;
		this.armedFor = null;
	}

	private rearm(): void {
		const next = this.readNextDueAt();
		if (next === null) {
			this.dispose();
			return;
		}
		if (this.armedFor !== next) {
			this.arm(next);
		}
	}

	private arm(at: number): void {
		if (this.timer) {
			clearTimeout(this.timer);
		}
		this.armedFor = at;
		const delayMs = Math.max(0, at - Date.now());
		this.timer = setTimeout(() => {
			this.armedFor = null;
			void this.onAlarmDue();
		}, delayMs);
	}

	private readNextDueJob(now: number): MaintenanceJob | null {
		const row = this.handle
			.exec<{ key: string; due_at: number; retry_count: number }>(
				`
				SELECT key, due_at, retry_count
				FROM maintenance_jobs
				WHERE due_at <= ?
				ORDER BY due_at ASC, key ASC
				LIMIT 1
				`,
				now,
			)
			.toArray()[0];
		if (!row || !isMaintenanceJobKey(row.key)) {
			return null;
		}

		return { key: row.key, dueAt: Number(row.due_at), retryCount: Number(row.retry_count) };
	}

	private readNextDueAt(): number | null {
		const row = this.handle
			.exec<{ due_at: number }>(
				`
				SELECT due_at
				FROM maintenance_jobs
				ORDER BY due_at ASC
				LIMIT 1
				`,
			)
			.toArray()[0];
		return row ? Number(row.due_at) : null;
	}

	private readJob(key: MaintenanceJobKey): MaintenanceJob | null {
		const row = this.handle
			.exec<{ key: string; due_at: number; retry_count: number }>(
				`
				SELECT key, due_at, retry_count
				FROM maintenance_jobs
				WHERE key = ?
				LIMIT 1
				`,
				key,
			)
			.toArray()[0];
		if (!row || !isMaintenanceJobKey(row.key)) {
			return null;
		}

		return { key: row.key, dueAt: Number(row.due_at), retryCount: Number(row.retry_count) };
	}

	private deleteJob(key: MaintenanceJobKey): void {
		this.handle.exec("DELETE FROM maintenance_jobs WHERE key = ?", key);
	}

	private rescheduleJob(key: MaintenanceJobKey, dueAt: number, now: number): void {
		const scheduledDueAt = maintenanceJobDueAt(key, dueAt);
		this.handle.exec(
			`
			INSERT INTO maintenance_jobs (key, due_at, retry_count, updated_at)
			VALUES (?, ?, 0, ?)
			ON CONFLICT(key) DO UPDATE SET
				due_at = excluded.due_at,
				retry_count = 0,
				last_error = NULL,
				last_error_at = NULL,
				updated_at = excluded.updated_at
			`,
			key,
			scheduledDueAt,
			now,
		);
	}

	private rescheduleFailedJob(
		job: MaintenanceJob,
		error: unknown,
		now: number,
	): { nextDueAt: number; retryCount: number } {
		const retryCount = job.retryCount + 1;
		const nextDueAt = now + maintenanceRetryDelayMs(retryCount);
		this.handle.exec(
			`
			UPDATE maintenance_jobs
			SET due_at = ?,
				retry_count = ?,
				last_error = ?,
				last_error_at = ?,
				updated_at = ?
			WHERE key = ?
			`,
			nextDueAt,
			retryCount,
			formatCompactError(error),
			now,
			now,
			job.key,
		);
		return { nextDueAt, retryCount };
	}
}

function isMaintenanceJobKey(value: string): value is MaintenanceJobKey {
	return value === "blob_gc" || value === "health_summary_flush";
}

function maintenanceRetryDelayMs(retryCount: number): number {
	return Math.min(
		MAINTENANCE_RETRY_MAX_MS,
		MAINTENANCE_RETRY_MIN_MS * 2 ** Math.max(0, retryCount - 1),
	);
}

function maintenanceJobDueAt(key: MaintenanceJobKey, dueAt: number): number {
	if (key !== "blob_gc") {
		return dueAt;
	}
	return Math.ceil(dueAt / BLOB_GC_ALARM_BUCKET_MS) * BLOB_GC_ALARM_BUCKET_MS;
}

function formatCompactError(error: unknown): string {
	if (error instanceof Error && error.message.trim()) {
		return error.message.slice(0, 500);
	}
	return String(error).slice(0, 500);
}

function logMaintenanceJobError(
	job: MaintenanceJob,
	failedJob: { nextDueAt: number; retryCount: number },
	error: unknown,
	now: number,
): void {
	console.error("[node-coordinator] maintenance job failed", {
		jobKey: job.key,
		dueAt: job.dueAt,
		failedAt: now,
		retryCount: failedJob.retryCount,
		nextDueAt: failedJob.nextDueAt,
		error: formatLogError(error),
	});
}

function formatLogError(error: unknown): Record<string, unknown> {
	if (error instanceof Error) {
		return { name: error.name, message: error.message, stack: error.stack, cause: error.cause };
	}
	return { message: String(error) };
}
