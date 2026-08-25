import type { BlobReferenceFacts } from "../../../domain/blob-gc-policy";
import type { BlobRow } from "./storage-models";

export type { BlobReferenceFacts } from "../../../domain/blob-gc-policy";

export type BlobStageFacts = {
	existing: {
		state: BlobRow["state"];
		sizeBytes: number;
		createdAt: number;
	} | null;
	referenceFacts: BlobReferenceFacts;
	storageUsedBytes: number;
	storageLimitBytes: number;
	maxFileSizeBytes: number;
};

export type BlobMutationFacts = {
	blob: {
		state: BlobRow["state"];
		sizeBytes: number;
	} | null;
	referenceFacts: BlobReferenceFacts;
};

export type BlobReferenceSnapshot = {
	blob: BlobRow | null;
	referenceFacts: BlobReferenceFacts;
};

export interface BlobStageTransaction {
	readFacts(): BlobStageFacts;
	persistStage(input: {
		sizeBytes: number;
		now: number;
		deleteAfter: number;
		storageDeltaBytes: number;
	}): void;
	pauseSync(now: number, reason: string): void;
}

export interface BlobMutationTransaction {
	readFacts(): BlobMutationFacts;
	deleteStagedBlob(): void;
}

export interface BlobStateStore {
	withStageTransaction<T>(
		blobId: string,
		now: number,
		operation: (transaction: BlobStageTransaction) => T,
	): T;
	withBlobTransaction<T>(
		blobId: string,
		now: number,
		operation: (transaction: BlobMutationTransaction) => T,
	): T;
	readBlob(blobId: string): BlobRow | null;
	readBlobFacts(blobId: string, now: number): BlobReferenceSnapshot;
	deleteBlobRecord(blobId: string): void;
}
