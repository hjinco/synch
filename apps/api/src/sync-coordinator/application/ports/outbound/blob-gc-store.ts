import type { BlobCollectionFacts } from "../../../domain/blob-gc-policy";
import type { BlobRow } from "./storage-models";

export type BlobGcCandidate = BlobRow;

export type BlobGcDeleteResult = "deleted" | "skipped";

export type BlobPendingDeleteFacts = BlobCollectionFacts | null;

export interface BlobPendingDeleteTransaction {
	readFacts(): BlobPendingDeleteFacts;
	markPendingDelete(deleteAfter: number): void;
}

export interface BlobGcStore {
	expireEntryVersions(now: number): void;
	listCollectibleBlobs(now: number, limit: number): BlobGcCandidate[];
	readCollectibleBlob(blobId: string, now: number): BlobGcCandidate | null;
	withPendingDeleteTransaction(
		blobId: string,
		now: number,
		operation: (transaction: BlobPendingDeleteTransaction) => void,
	): void;
	deleteCollectibleBlobs(blobIds: readonly string[], now: number): BlobGcCandidate[];
	deleteBlobIfCollectible(blobId: string, now: number): BlobGcDeleteResult;
	readGcDeadlines(now: number): readonly number[];
}
