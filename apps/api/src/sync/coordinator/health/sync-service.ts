import type { MaintenanceScheduler } from "../maintenance-scheduler";
import type { HealthStateStore } from "../ports";
import { nextHealthSummaryFlushAt } from "../store/health-store";
import type { VaultSyncStatusSummary } from "../../health/types";

const DEFAULT_HEALTH_SUMMARY_FLUSH_DELAY_MS = 10 * 60 * 1000;

export interface VaultSyncStatusWriter {
	upsert(summary: VaultSyncStatusSummary, flushedAt: number): Promise<void>;
}

export class HealthSyncService {
	private scheduledFlushAt: number | null = null;

	constructor(
		private readonly healthStore: HealthStateStore,
		private readonly syncStatusRepository: VaultSyncStatusWriter | null,
		private readonly cursorActiveTtlMs: number,
		private readonly maintenanceScheduler: MaintenanceScheduler,
	) {}

	async scheduleSummaryFlush(now = Date.now()): Promise<void> {
		const flushAt = now + DEFAULT_HEALTH_SUMMARY_FLUSH_DELAY_MS;
		if (this.scheduledFlushAt !== null && this.scheduledFlushAt <= flushAt) {
			return;
		}

		await this.maintenanceScheduler.defer("health_summary_flush", flushAt, now);
		this.scheduledFlushAt = flushAt;
	}

	async flushSummary(
		options: { now?: number; throwOnError?: boolean } = {},
	): Promise<number | null> {
		if (!this.syncStatusRepository) {
			return null;
		}

		const now = options.now ?? Date.now();
		const summary = this.healthStore.readHealthSummary(now, this.cursorActiveTtlMs);
		if (!summary) {
			return null;
		}

		try {
			await this.syncStatusRepository.upsert(summary, now);
			const nextDueAt = nextHealthSummaryFlushAt(summary, now);
			this.scheduledFlushAt = nextDueAt;
			if (nextDueAt !== null) {
				await this.maintenanceScheduler.defer(
					"health_summary_flush",
					nextDueAt,
					now,
				);
			}
			return nextDueAt;
		} catch (error) {
			this.scheduledFlushAt = null;
			if (options.throwOnError) {
				throw error;
			}
			await this.maintenanceScheduler.defer("health_summary_flush", now, now);
			return null;
		}
	}
}
