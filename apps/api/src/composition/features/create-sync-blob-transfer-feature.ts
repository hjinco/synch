import type { VerifySyncToken } from "../../sync-access/application";
import type { BlobObjectStorage } from "../../sync-blob-transfer/application/ports/outbound/blob-object-storage";
import type { BlobObjectKeyBuilder } from "../../sync-blob-transfer/application/ports/outbound/blob-object-key-builder";
import type { DownloadBlob, UploadBlob } from "../../sync-blob-transfer/application";
import { CoordinatorBlobStagerAdapter, type CoordinatorNamespace } from "../../sync-blob-transfer/adapters/outbound/coordinator-blob-stager";
import { DownloadBlobUseCase } from "../../sync-blob-transfer/application/use-cases/download-blob";
import { UploadBlobUseCase } from "../../sync-blob-transfer/application/use-cases/upload-blob";

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
	return {
		uploadBlob: new UploadBlobUseCase(
			config.tokenVerifier,
			coordinatorBlobStager,
			config.objectStorage,
			config.objectKeyBuilder,
		),
		downloadBlob: new DownloadBlobUseCase(
			config.tokenVerifier,
			config.objectStorage,
			config.objectKeyBuilder,
		),
	};
}
