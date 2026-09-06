import { SyncCoordinatorApplicationError } from "../errors/coordinator-errors";
import { type BlobStageDecision } from "../../domain/blob-policy";
import { isBlobPinned } from "../../domain/blob-gc-policy";
import {
	stageBlobRecord,
	accountForDeletedBlobs,
	deleteUnreferencedStagedBlob,
} from "./blob-record-operations";
import type {
	BlobObjectKeyBuilder,
	BlobObjectRepository,
	CoordinatorUnitOfWork,
	SocketGateway,
	SyncTokenVerifier,
} from "../ports/outbound";
import type { BlobGcService } from "./blob-gc-service";
import type { HealthService } from "./health-service";

export class BlobService {
	constructor(
		private readonly syncTokenService: SyncTokenVerifier,
		private readonly unitOfWork: CoordinatorUnitOfWork<
			"blobs" | "blobReferences" | "state"
		>,
		private readonly blobGcService: Pick<BlobGcService, "scheduleAt">,
		private readonly socketService: Pick<SocketGateway, "closeAllSockets">,
		private readonly blobRepository: BlobObjectRepository,
		private readonly objectKeyBuilder: BlobObjectKeyBuilder,
		private readonly blobGracePeriodMs: number,
		private readonly healthService: Pick<
			HealthService,
			"scheduleSummaryFlush" | "notifyStorageStatusChanged"
		>,
	) {}

	async stageBlob(
		token: string | null | undefined,
		vaultId: string,
		blobId: string,
		sizeBytes: number,
	): Promise<void> {
		await this.syncTokenService.verifySyncToken(token, vaultId);

		const now = Date.now();
		const decision = this.unitOfWork.run((stores) =>
			stageBlobRecord(
				stores,
				blobId,
				sizeBytes,
				now,
				now + this.blobGracePeriodMs,
			),
		);
		if (decision.kind === "rejected") throwBlobStageError(blobId, decision);

		if (decision.kind === "sync_paused") {
			this.socketService.closeAllSockets(4403, "sync paused for vault repair");
			throw syncPausedError();
		}

		await this.blobGcService.scheduleAt(now + this.blobGracePeriodMs, now);
		this.healthService.notifyStorageStatusChanged();
	}

	async abortStagedBlob(
		token: string | null | undefined,
		vaultId: string,
		blobId: string,
	): Promise<void> {
		await this.syncTokenService.verifySyncToken(token, vaultId);
		const now = Date.now();
		this.unitOfWork.run((stores) =>
			deleteUnreferencedStagedBlob(stores, blobId, now),
		);
		await this.healthService.scheduleSummaryFlush();
		this.healthService.notifyStorageStatusChanged();
	}

	async deleteBlob(
		token: string | null | undefined,
		vaultId: string,
		blobId: string,
	): Promise<void> {
		await this.syncTokenService.verifySyncToken(token, vaultId);
		const now = Date.now();
		const { blob, referenceFacts } = this.unitOfWork.run((stores) => ({
			blob: stores.blobs.readBlob(blobId),
			referenceFacts: stores.blobReferences.read(blobId, now),
		}));
		if (blob && isBlobPinned(referenceFacts)) {
			return;
		}

		await this.blobRepository.delete(
			this.objectKeyBuilder.blobObjectKey(vaultId, blobId),
		);
		if (blob) {
			this.unitOfWork.run((stores) => {
				accountForDeletedBlobs(
					stores.state,
					stores.blobs.deleteBlobRecord(blobId),
				);
			});
			await this.healthService.scheduleSummaryFlush();
			this.healthService.notifyStorageStatusChanged();
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
