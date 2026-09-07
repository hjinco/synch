import { BlobTransferApplicationError } from "../errors/blob-transfer-errors";
import { isSafeBlobId } from "../../domain/id-policy";
import type { DownloadBlob } from "../ports/inbound/download-blob";
import type { UploadBlob } from "../ports/inbound/upload-blob";
import type { CoordinatorBlobStager } from "../ports/outbound/coordinator-blob-stager";
import type { BlobObjectStorage } from "../ports/outbound/blob-object-storage";
import type { VerifySyncToken } from "../../../sync-access/application";
import type {
	BlobDownloadInput,
	BlobUploadInput,
	BlobUploadResponse,
} from "../dto/blob-transfer";
import type { BlobObjectKeyBuilder } from "../ports/outbound/blob-object-key-builder";

export class BlobTransferService implements UploadBlob, DownloadBlob {
	constructor(
		private readonly tokenVerifier: VerifySyncToken,
		private readonly coordinatorBlobStager: CoordinatorBlobStager,
		private readonly blobStorage: BlobObjectStorage,
		private readonly objectKeyBuilder: BlobObjectKeyBuilder,
	) {}

	async uploadBlob(input: BlobUploadInput): Promise<BlobUploadResponse> {
		if (!isSafeBlobId(input.vaultId) || !isSafeBlobId(input.blobId)) {
			throw new BlobTransferApplicationError("invalid_id");
		}
		await this.tokenVerifier.verifySyncToken(input.token, input.vaultId);
		await this.coordinatorBlobStager.stageBlob({
			vaultId: input.vaultId,
			blobId: input.blobId,
			sizeBytes: input.declaredSizeBytes,
			token: input.token,
		});

		const objectKey = this.objectKeyBuilder.blobObjectKey(input.vaultId, input.blobId);
		let uploaded: { size: number; sizeMismatch: boolean };
		try {
			uploaded = await this.blobStorage.upload(
				objectKey,
				input.body,
				input.declaredSizeBytes,
			);
		} catch (error) {
			await this.abortUpload(input);
			throw error;
		}

		if (
			uploaded.sizeMismatch ||
			uploaded.size !== input.declaredSizeBytes
		) {
			await this.abortUpload(input);
			throw new BlobTransferApplicationError("size_mismatch", {
				declaredSizeBytes: input.declaredSizeBytes,
			});
		}

		return { ok: true, blobId: input.blobId };
	}

	private async abortUpload(input: BlobUploadInput): Promise<void> {
		try {
			await this.coordinatorBlobStager.abortStagedBlob({
				vaultId: input.vaultId,
				blobId: input.blobId,
			});
		} catch {
			// GC retains responsibility for leftover stages if the coordinator is
			// unavailable. Never replace the original transfer error with cleanup.
			console.warn("[blob-transfer] staged upload cleanup failed", {
				vaultId: input.vaultId, blobId: input.blobId,
			});
		}
	}

	async downloadBlob(input: BlobDownloadInput): Promise<ReadableStream<Uint8Array> | null> {
		if (!isSafeBlobId(input.vaultId) || !isSafeBlobId(input.blobId)) {
			throw new BlobTransferApplicationError("invalid_id");
		}
		await this.tokenVerifier.verifySyncToken(input.token, input.vaultId);
		return await this.blobStorage.download(
			this.objectKeyBuilder.blobObjectKey(input.vaultId, input.blobId),
		);
	}
}
