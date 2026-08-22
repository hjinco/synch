import { SyncCoordinatorApplicationError } from "../../errors/coordinator-errors";
import {
	decideBlobStage,
	type BlobStageDecision,
} from "../../../domain/blob-policy";
import { STAGED_BLOB_STALE_MS } from "../../../domain/health-policy";
import type { MaintenanceScheduler } from "../../ports/outbound";
import type {
	BlobObjectRepository,
	BlobStateStore,
	HealthStateStore,
		HealthSummaryScheduler,
		BlobObjectKeyBuilder,
	SocketGateway,
	SyncTokenVerifier,
	VaultStateStore,
} from "../../ports/outbound";

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
		private readonly objectKeyBuilder: BlobObjectKeyBuilder,
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
		token: string | null | undefined,
		vaultId: string,
		blobId: string,
		sizeBytes: number,
	): Promise<void> {
		await this.syncTokenService.verifySyncToken(token, vaultId);

		const now = Date.now();
		const decision = this.blobStore.withStageTransaction(blobId, now, (transaction) => {
			const facts = transaction.readFacts();
			const next = decideBlobStage({
				blobId,
				sizeBytes,
				now,
				staleAfterMs: STAGED_BLOB_STALE_MS,
				...facts,
			});

			if (next.kind === "sync_paused") {
				transaction.pauseSync(now, next.reason);
				return next;
			}
			if (next.kind === "rejected") {
				throwBlobStageError(blobId, next);
			}

			transaction.persistStage({
				sizeBytes,
				now,
				deleteAfter: now + this.blobGracePeriodMs,
				storageDeltaBytes: next.storageDeltaBytes,
			});
			return next;
		});
		if (decision.kind === "sync_paused") {
			this.socketService.closeAllSockets(4403, "sync paused for vault repair");
			throw syncPausedError();
		}

		await this.maintenanceScheduler.defer(
			"blob_gc",
			now + this.blobGracePeriodMs,
			now,
		);
		this.broadcastStorageStatus();
	}

	async abortStagedBlob(
		token: string | null | undefined,
		vaultId: string,
		blobId: string,
	): Promise<void> {
		await this.syncTokenService.verifySyncToken(token, vaultId);
		this.blobStore.abortStagedBlob(blobId, Date.now());
		await this.healthSummaryScheduler.scheduleSummaryFlush();
		this.broadcastStorageStatus();
	}

	async deleteBlob(token: string | null | undefined, vaultId: string, blobId: string): Promise<void> {
		await this.syncTokenService.verifySyncToken(token, vaultId);
		const blob = this.blobStore.readBlob(blobId);
		if (blob && this.blobStore.isBlobPinned(blobId, false)) {
			return;
		}

		await this.blobRepository.delete(this.objectKeyBuilder.blobObjectKey(vaultId, blobId));
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
			await this.blobRepository.delete(
				this.objectKeyBuilder.blobObjectKey(effectiveVaultId, blob.blob_id),
			);
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
				await this.blobRepository.delete(this.objectKeyBuilder.blobObjectKey(vaultId, blobId));
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
	return new SyncCoordinatorApplicationError("sync_paused");
}

function throwBlobStageError(
	blobId: string,
	decision: Extract<BlobStageDecision, { kind: "rejected" }>,
): never {
	switch (decision.code) {
		case "file_too_large":
			throw new SyncCoordinatorApplicationError("file_too_large", {
				message: `blob exceeds maximum file size of ${decision.maxFileSizeBytes} bytes`,
				maxFileSizeBytes: decision.maxFileSizeBytes,
				sizeBytes: decision.sizeBytes,
			});
		case "blob_already_live":
			throw new SyncCoordinatorApplicationError("blob_already_live", {
				message: `blob ${blobId} is already live`,
				blobId,
			});
		case "blob_size_changed":
			throw new SyncCoordinatorApplicationError("blob_size_changed", {
				message: `blob ${blobId} size changed between staged uploads`,
				blobId,
				previousSizeBytes: decision.previousSizeBytes,
				sizeBytes: decision.sizeBytes,
			});
		case "quota_exceeded":
			throw new SyncCoordinatorApplicationError("quota_exceeded", {
				message: `vault storage quota exceeded: ${(decision.usedBytes ?? 0) + decision.sizeBytes}/${decision.storageLimitBytes} bytes`,
				storageLimitBytes: decision.storageLimitBytes,
				sizeBytes: decision.sizeBytes,
				usedBytes: decision.usedBytes,
			});
	}
}
