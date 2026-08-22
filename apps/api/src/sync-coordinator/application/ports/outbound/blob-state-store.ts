import type { BlobRow } from "./storage-models";

export type UnreferencedStagedBlobDeleteResult = "deleted" | "missing" | "referenced";

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
	listStaleStagedBlobs(now: number, staleAfterMs: number, limit: number): BlobRow[];
	deleteBlobRecord(blobId: string): void;
	abortStagedBlob(blobId: string, now?: number): void;
	deleteUnreferencedStagedBlob(blobId: string, now?: number): UnreferencedStagedBlobDeleteResult;
	isBlobPinned(blobId: string, includeStaging?: boolean, now?: number): boolean;
	listBlobsReadyForDeletion(now: number, limit: number): BlobRow[];
	deleteBlobIfCollectible(blobId: string, now?: number): void;
	markBlobPendingDeleteIfUnpinned(blobId: string, now?: number): void;
	nextBlobGcAt(): number | null;
}
