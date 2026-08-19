import { BlobTransferApplicationError } from "../errors/blob-transfer-errors";
import { isSafeBlobId } from "../../domain/id-policy";
import type { UploadBlob } from "../ports/inbound/upload-blob";
import type { CoordinatorBlobStager } from "../ports/outbound/coordinator-blob-stager";
import type { BlobObjectStorage } from "../ports/outbound/blob-object-storage";
import type { VerifySyncToken } from "../../../sync-access/application";
import type { BlobUploadInput, BlobUploadResponse } from "../dto/blob-transfer";
import type { BlobObjectKeyBuilder } from "../ports/outbound/blob-object-key-builder";

export class UploadBlobUseCase implements UploadBlob {
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
			await this.coordinatorBlobStager.abortStagedBlob({
				vaultId: input.vaultId,
				blobId: input.blobId,
				token: input.token,
			});
			throw error;
		}

		if (
			uploaded.sizeMismatch ||
			uploaded.size !== input.declaredSizeBytes
		) {
			await this.blobStorage.delete(objectKey).catch(() => {});
			await this.coordinatorBlobStager.abortStagedBlob({
				vaultId: input.vaultId,
				blobId: input.blobId,
				token: input.token,
			});
			throw new BlobTransferApplicationError("size_mismatch", {
				declaredSizeBytes: input.declaredSizeBytes,
			});
		}

		return { ok: true, blobId: input.blobId };
	}
}
