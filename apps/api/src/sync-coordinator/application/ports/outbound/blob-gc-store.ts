import type { BlobRow } from "./storage-models";

export type BlobGcCandidate = BlobRow;

export type BlobGcDeleteResult = "deleted" | "skipped";

export interface BlobGcStore {
	expireEntryVersions(now: number): void;
	listCollectibleBlobs(now: number, limit: number): BlobGcCandidate[];
	readCollectibleBlob(blobId: string, now: number): BlobGcCandidate | null;
	markBlobPendingDeleteIfUnpinned(blobId: string, now: number): void;
	deleteCollectibleBlobs(blobIds: readonly string[], now: number): BlobGcCandidate[];
	deleteBlobIfCollectible(blobId: string, now: number): BlobGcDeleteResult;
	nextGcAt(now: number): number | null;
}
