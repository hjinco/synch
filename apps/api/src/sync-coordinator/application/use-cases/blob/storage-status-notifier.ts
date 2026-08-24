import type { StorageStatusNotifier } from "../../ports/outbound/storage-status-notifier";
import type { HealthStateStore, SocketGateway } from "../../ports/outbound";

const DEFAULT_STORAGE_STATUS_BROADCAST_DELAY_MS = 300;

export class CoalescedStorageStatusNotifier implements StorageStatusNotifier {
	private storageStatusBroadcastTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly healthStore: Pick<HealthStateStore, "readStorageStatus">,
		private readonly socketService: Pick<SocketGateway, "broadcastStorageStatus">,
		private readonly storageStatusBroadcastDelayMs =
			DEFAULT_STORAGE_STATUS_BROADCAST_DELAY_MS,
	) {}

	notifyStorageStatusChanged(): void {
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
