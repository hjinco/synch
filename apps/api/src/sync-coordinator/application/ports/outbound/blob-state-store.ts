import type { BlobRow } from "./storage-models";

export type BlobStageFacts = {
	existing: {
		state: BlobRow["state"];
		sizeBytes: number;
		createdAt: number;
	} | null;
	isPinned: boolean;
	storageUsedBytes: number;
	storageLimitBytes: number;
	maxFileSizeBytes: number;
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

export interface BlobStateStore {
	withStageTransaction<T>(
		blobId: string,
		now: number,
		operation: (transaction: BlobStageTransaction) => T,
	): T;
	readBlob(blobId: string): BlobRow | null;
	deleteBlobRecord(blobId: string): void;
	abortStagedBlob(blobId: string, now?: number): void;
	isBlobPinned(blobId: string, includeStaging?: boolean, now?: number): boolean;
}
