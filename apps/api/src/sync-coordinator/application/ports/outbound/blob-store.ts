import type { BlobRow, BlobState } from "./storage-models";
import type { BlobReferenceFacts } from "../../../domain/blob-gc-policy";
export interface BlobStore {
	readBlob(blobId: string): BlobRow | null;
	persistStage(
		blobId: string,
		input: { sizeBytes: number; now: number; deleteAfter: number },
	): void;
	updateState(
		blobId: string,
		state: BlobState,
		deleteAfter: number | null,
	): void;
	/** Returns only rows actually removed. The caller accounts for them in the same transaction. */
	deleteBlobRecord(blobId: string, expectedState?: BlobState): BlobRow[];
	deleteCollectibleBlobs(blobIds: readonly string[], now: number): BlobRow[];
	listStaleStagedBlobs(createdBefore: number, limit: number): BlobRow[];
}
export interface BlobReferenceStore {
	read(blobId: string, now: number): BlobReferenceFacts;
}
