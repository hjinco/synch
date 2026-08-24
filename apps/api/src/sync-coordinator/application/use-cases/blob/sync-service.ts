import { SyncCoordinatorApplicationError } from "../../errors/coordinator-errors";
import {
	decideBlobStage,
	type BlobStageDecision,
} from "../../../domain/blob-policy";
import { STAGED_BLOB_STALE_MS } from "../../../domain/health-policy";
import type {
	BlobGcScheduler,
	BlobObjectKeyBuilder,
	BlobObjectRepository,
	BlobStateStore,
	HealthSummaryScheduler,
	SocketGateway,
	StorageStatusNotifier,
	SyncTokenVerifier,
} from "../../ports/outbound";

export class BlobTransferService {
	constructor(
		private readonly syncTokenService: SyncTokenVerifier,
		private readonly blobStore: BlobStateStore,
		private readonly blobGcScheduler: BlobGcScheduler,
		private readonly socketService: Pick<
			SocketGateway,
			"closeAllSockets"
		>,
		private readonly blobRepository: BlobObjectRepository,
		private readonly objectKeyBuilder: BlobObjectKeyBuilder,
		private readonly blobGracePeriodMs: number,
		private readonly healthSummaryScheduler: HealthSummaryScheduler,
		private readonly storageStatusNotifier: StorageStatusNotifier,
	) {}

	dispose(): void {
		this.storageStatusNotifier.dispose();
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

		await this.blobGcScheduler.scheduleAt(
			now + this.blobGracePeriodMs,
			now,
		);
		this.storageStatusNotifier.notifyStorageStatusChanged();
	}

	async abortStagedBlob(
		token: string | null | undefined,
		vaultId: string,
		blobId: string,
	): Promise<void> {
		await this.syncTokenService.verifySyncToken(token, vaultId);
		this.blobStore.abortStagedBlob(blobId, Date.now());
		await this.healthSummaryScheduler.scheduleSummaryFlush();
		this.storageStatusNotifier.notifyStorageStatusChanged();
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
			this.storageStatusNotifier.notifyStorageStatusChanged();
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
