import { DomainError, apiError, domainApiError } from "../../../errors";
import { blobObjectKey } from "../../blob/object-key";
import type { MaintenanceScheduler } from "../maintenance-scheduler";
import type {
	BlobObjectRepository,
	BlobStateStore,
	HealthStateStore,
	HealthSummaryScheduler,
	SocketGateway,
	SyncTokenVerifier,
	VaultStateStore,
} from "../ports";

const GC_BATCH_SIZE = 64;
const DEFAULT_STORAGE_STATUS_BROADCAST_DELAY_MS = 300;

export class BlobSyncService {
	constructor(
		private readonly syncTokenService: SyncTokenVerifier,
		private readonly blobStore: BlobStateStore,
		private readonly vaultStateStore: Pick<VaultStateStore, "readVaultId">,
		private readonly healthStore: Pick<
			HealthStateStore,
			"recordGcCompleted" | "readStorageStatus"
		>,
		private readonly socketService: Pick<
			SocketGateway,
			"broadcastStorageStatus" | "closeAllSockets"
		>,
		private readonly blobRepository: BlobObjectRepository,
		private readonly blobGracePeriodMs: number,
		private readonly maintenanceScheduler: MaintenanceScheduler,
		private readonly healthSummaryScheduler: HealthSummaryScheduler,
		private readonly storageStatusBroadcastDelayMs =
			DEFAULT_STORAGE_STATUS_BROADCAST_DELAY_MS,
	) {}

	private storageStatusBroadcastTimer: ReturnType<typeof setTimeout> | null = null;

	dispose(): void {
		if (this.storageStatusBroadcastTimer !== null) {
			clearTimeout(this.storageStatusBroadcastTimer);
			this.storageStatusBroadcastTimer = null;
		}
	}

	async stageBlob(
		request: Request,
		vaultId: string,
		blobId: string,
		sizeBytes: number,
	): Promise<void> {
		await this.syncTokenService.requireSyncToken(request, vaultId);

		const now = Date.now();
		try {
			const result = await this.blobStore.stageBlob(
				blobId,
				sizeBytes,
				now,
				now + this.blobGracePeriodMs,
			);
			if (result.status === "sync_paused") {
				this.socketService.closeAllSockets(4403, "sync paused for vault repair");
				throw syncPausedError();
			}
			await this.maintenanceScheduler.defer(
				"blob_gc",
				now + this.blobGracePeriodMs,
				now,
			);
			this.broadcastStorageStatus();
		} catch (error) {
			if (error instanceof DomainError) {
				throw domainApiError(error);
			}
			throw error;
		}
	}

	async abortStagedBlob(
		request: Request,
		vaultId: string,
		blobId: string,
	): Promise<void> {
		await this.syncTokenService.requireSyncToken(request, vaultId);
		this.blobStore.abortStagedBlob(blobId, Date.now());
		await this.healthSummaryScheduler.scheduleSummaryFlush();
		this.broadcastStorageStatus();
	}

	async deleteBlob(request: Request, vaultId: string, blobId: string): Promise<void> {
		await this.syncTokenService.requireSyncToken(request, vaultId);
		const blob = this.blobStore.readBlob(blobId);
		if (blob && this.blobStore.isBlobPinned(blobId, false)) {
			return;
		}

		await this.blobRepository.delete(blobObjectKey(vaultId, blobId));
		if (blob) {
			this.blobStore.deleteBlobRecord(blobId);
			await this.healthSummaryScheduler.scheduleSummaryFlush();
			this.broadcastStorageStatus();
		}
	}

	async runGc(
		vaultId?: string,
		options: {
			now?: number;
			scheduleHealthFlush?: boolean;
			scheduleNextGc?: boolean;
		} = {},
	): Promise<number | null> {
		const effectiveVaultId = vaultId ?? this.vaultStateStore.readVaultId();
		if (!effectiveVaultId) {
			return null;
		}

		const now = options.now ?? Date.now();
		const due = this.blobStore.listBlobsReadyForDeletion(now, GC_BATCH_SIZE);
		for (const blob of due) {
			await this.blobRepository.delete(blobObjectKey(effectiveVaultId, blob.blob_id));
			this.blobStore.deleteBlobIfCollectible(blob.blob_id, now);
		}

		const nextGcAt = this.blobStore.nextBlobGcAt();
		if ((options.scheduleNextGc ?? true) && nextGcAt !== null) {
			await this.maintenanceScheduler.defer("blob_gc", nextGcAt, now);
		}
		this.healthStore.recordGcCompleted(now);
		if (options.scheduleHealthFlush ?? true) {
			await this.maintenanceScheduler.defer("health_summary_flush", now, now);
		}
		if (due.length > 0) {
			this.broadcastStorageStatus();
		}
		return nextGcAt;
	}

	async collectPurgedBlobs(
		vaultId: string,
		blobIds: readonly string[],
	): Promise<void> {
		const uniqueBlobIds = [...new Set(blobIds)];
		if (uniqueBlobIds.length === 0) {
			return;
		}

		const now = Date.now();
		let deletedCount = 0;
		for (const blobId of uniqueBlobIds) {
			this.blobStore.markBlobPendingDeleteIfUnpinned(blobId, now);
			const blob = this.blobStore.readBlob(blobId);
			if (
				!blob ||
				blob.state !== "pending_delete" ||
				(blob.delete_after !== null && blob.delete_after > now) ||
				this.blobStore.isBlobPinned(blobId, false, now)
			) {
				continue;
			}

			try {
				await this.blobRepository.delete(blobObjectKey(vaultId, blobId));
				this.blobStore.deleteBlobIfCollectible(blobId, now);
				deletedCount += 1;
			} catch (error) {
				console.error("[sync-coordinator] immediate purged blob deletion failed", {
					vaultId,
					blobId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		const nextGcAt = this.blobStore.nextBlobGcAt();
		if (nextGcAt !== null) {
			await this.maintenanceScheduler.defer("blob_gc", nextGcAt, now);
		}
		await this.healthSummaryScheduler.scheduleSummaryFlush(now);
		if (deletedCount > 0) {
			this.broadcastStorageStatus();
		}
	}

	private broadcastStorageStatus(): void {
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

function syncPausedError() {
	return apiError(403, "forbidden", "vault sync is temporarily paused for repair");
}
