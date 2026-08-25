import type {
	HealthStateStore,
	MaintenanceScheduler,
	SocketGateway,
	VaultSyncStatusSummary,
	VaultSyncStatusWriter,
} from "../ports/outbound";
import {
	evaluateHealth,
	nextHealthSummaryFlushAt,
} from "../../domain/health-policy";

const DEFAULT_HEALTH_SUMMARY_FLUSH_DELAY_MS = 10 * 60 * 1000;
const DEFAULT_STORAGE_STATUS_BROADCAST_DELAY_MS = 300;

export class HealthService {
	private scheduledFlushAt: number | null = null;
	private storageStatusBroadcastTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly healthStore: HealthStateStore,
		private readonly syncStatusRepository: VaultSyncStatusWriter | null,
		private readonly cursorActiveTtlMs: number,
		private readonly maintenanceScheduler: MaintenanceScheduler,
		private readonly socketService: Pick<
			SocketGateway,
			"broadcastStorageStatus"
		> | null = null,
		private readonly storageStatusBroadcastDelayMs =
			DEFAULT_STORAGE_STATUS_BROADCAST_DELAY_MS,
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
		const snapshot = this.healthStore.readHealthSnapshot(now, this.cursorActiveTtlMs);
		if (!snapshot) {
			return null;
		}

		const evaluated = evaluateHealth(snapshot, now);
		const summary: VaultSyncStatusSummary = {
			...snapshot,
			healthStatus: evaluated.status,
			healthReasons: evaluated.reasons,
		};

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

	notifyStorageStatusChanged(): void {
		if (!this.socketService) {
			return;
		}
		if (this.storageStatusBroadcastDelayMs <= 0) {
			this.flushStorageStatusBroadcast();
			return;
		}

		if (this.storageStatusBroadcastTimer !== null) {
			return;
		}

		this.storageStatusBroadcastTimer = setTimeout(() => {
			this.storageStatusBroadcastTimer = null;
			this.flushStorageStatusBroadcast();
		}, this.storageStatusBroadcastDelayMs);
	}

	dispose(): void {
		if (this.storageStatusBroadcastTimer !== null) {
			clearTimeout(this.storageStatusBroadcastTimer);
			this.storageStatusBroadcastTimer = null;
		}
	}

	private flushStorageStatusBroadcast(): void {
		if (!this.socketService) {
			return;
		}
		try {
			this.socketService.broadcastStorageStatus({
				type: "storage_status_updated",
				// Read at flush time so concurrent blob operations are represented by
				// the latest storage counter, rather than the snapshot that scheduled
				// this broadcast.
				storageStatus: this.healthStore.readStorageStatus(),
			});
		} catch (error) {
			// Storage status is advisory; a failed notification must not turn a
			// completed blob mutation into a failed request.
			console.error("[sync-coordinator] storage status broadcast failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}
