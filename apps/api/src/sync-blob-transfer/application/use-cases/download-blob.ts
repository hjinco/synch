import { BlobTransferApplicationError } from "../errors/blob-transfer-errors";
import { isSafeBlobId } from "../../domain/id-policy";
import type { DownloadBlob } from "../ports/inbound/download-blob";
import type { BlobObjectStorage } from "../ports/outbound/blob-object-storage";
import type { VerifySyncToken } from "../../../sync-access/application";
import type { BlobDownloadInput } from "../dto/blob-transfer";
import type { BlobObjectKeyBuilder } from "../ports/outbound/blob-object-key-builder";

export class DownloadBlobUseCase implements DownloadBlob {
	constructor(
		private readonly tokenVerifier: VerifySyncToken,
		private readonly blobStorage: BlobObjectStorage,
		private readonly objectKeyBuilder: BlobObjectKeyBuilder,
	) {}

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
