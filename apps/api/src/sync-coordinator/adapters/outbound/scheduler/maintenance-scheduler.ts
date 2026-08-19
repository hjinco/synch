const MAX_DRAINED_JOBS_PER_ALARM = 16;
const MAINTENANCE_RETRY_MIN_MS = 30 * 1000;
const MAINTENANCE_RETRY_MAX_MS = 15 * 60 * 1000;
const BLOB_GC_ALARM_BUCKET_MS = 30 * 60 * 1000;

import type {
	MaintenanceJobHandler,
	MaintenanceJobHandlers,
	MaintenanceJobKey,
	MaintenanceRunner,
	MaintenanceScheduler,
} from "../../../application/ports/outbound";

type MaintenanceJob = {
	key: MaintenanceJobKey;
	dueAt: number;
	retryCount: number;
};

export type {
	MaintenanceJobHandler,
	MaintenanceJobHandlers,
	MaintenanceJobKey,
	MaintenanceRunner,
	MaintenanceScheduler,
} from "../../../application/ports/outbound";

export class CoordinatorMaintenanceScheduler {
	constructor(private readonly ctx: DurableObjectState) {}

	async defer(
		key: MaintenanceJobKey,
		dueAt: number,
		now = Date.now(),
	): Promise<void> {
		const scheduledDueAt = maintenanceJobDueAt(key, dueAt);
		const existing = this.readJob(key);
		if (existing && existing.dueAt <= scheduledDueAt) {
			return;
		}

		this.ctx.storage.sql.exec(
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
		await this.rearm();
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

		await this.rearm();
	}

	async rearm(): Promise<void> {
		const next = this.readNextDueAt();
		if (next === null) {
			await this.ctx.storage.deleteAlarm();
			return;
		}

		const existing = await this.ctx.storage.getAlarm();
		if (existing !== next) {
			await this.ctx.storage.setAlarm(next);
		}
	}

	async ensureArmed(): Promise<void> {
		const next = this.readNextDueAt();
		if (next === null) {
			return;
		}

		const existing = await this.ctx.storage.getAlarm();
		if (existing === null || existing > next) {
			await this.ctx.storage.setAlarm(next);
		}
	}

	private readNextDueJob(now: number): MaintenanceJob | null {
		const row = this.ctx.storage.sql
			.exec<{
				key: string;
				due_at: number;
				retry_count: number;
			}>(
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

		return {
			key: row.key,
			dueAt: Number(row.due_at),
			retryCount: Number(row.retry_count),
		};
	}

	private readNextDueAt(): number | null {
		const row = this.ctx.storage.sql
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
		const row = this.ctx.storage.sql
			.exec<{
				key: string;
				due_at: number;
				retry_count: number;
			}>(
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

		return {
			key: row.key,
			dueAt: Number(row.due_at),
			retryCount: Number(row.retry_count),
		};
	}

	private deleteJob(key: MaintenanceJobKey): void {
		this.ctx.storage.sql.exec("DELETE FROM maintenance_jobs WHERE key = ?", key);
	}

	private rescheduleJob(
		key: MaintenanceJobKey,
		dueAt: number,
		now: number,
	): void {
		const scheduledDueAt = maintenanceJobDueAt(key, dueAt);
		this.ctx.storage.sql.exec(
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
		this.ctx.storage.sql.exec(
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
	console.error("[sync-coordinator] maintenance job failed", {
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
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			cause: error.cause,
		};
	}
	return {
		message: String(error),
	};
}
