import type { VerifySyncToken } from "../../sync-access/application";
import type { BlobObjectStorage } from "../../sync-blob-transfer/application/ports/outbound/blob-object-storage";
import type { BlobObjectKeyBuilder } from "../../sync-blob-transfer/application/ports/outbound/blob-object-key-builder";
import type { DownloadBlob, UploadBlob } from "../../sync-blob-transfer/application";
import { BlobTransferService } from "../../sync-blob-transfer/application/services/blob-transfer-service";
import { CoordinatorBlobStagerAdapter, type CoordinatorNamespace } from "../../sync-blob-transfer/adapters/outbound/coordinator-blob-stager";

export type SyncBlobTransferFeature = {
	uploadBlob: UploadBlob;
	downloadBlob: DownloadBlob;
};

export function createSyncBlobTransferFeature(config: {
	objectStorage: BlobObjectStorage;
	coordinatorNamespace: CoordinatorNamespace;
	tokenVerifier: VerifySyncToken;
	objectKeyBuilder: BlobObjectKeyBuilder;
}): SyncBlobTransferFeature {
	const coordinatorBlobStager = new CoordinatorBlobStagerAdapter(
		config.coordinatorNamespace,
	);
	const blobTransferService = new BlobTransferService(
		config.tokenVerifier,
		coordinatorBlobStager,
		config.objectStorage,
		config.objectKeyBuilder,
	);
	return {
		uploadBlob: blobTransferService,
		downloadBlob: blobTransferService,
	};
}
