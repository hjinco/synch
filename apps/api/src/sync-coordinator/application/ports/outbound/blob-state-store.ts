import type { BlobRow } from "../../dto/types";

export type UnreferencedStagedBlobDeleteResult = "deleted" | "missing" | "referenced";
export type StageBlobResult = { status: "staged" } | { status: "sync_paused" };

export interface BlobStateStore {
	stageBlob(blobId: string, sizeBytes: number, now: number, deleteAfter: number): Promise<StageBlobResult>;
	readBlob(blobId: string): BlobRow | null;
	listStaleStagedBlobs(now: number, limit: number): BlobRow[];
	deleteBlobRecord(blobId: string): void;
	abortStagedBlob(blobId: string, now?: number): void;
	deleteUnreferencedStagedBlob(blobId: string, now?: number): UnreferencedStagedBlobDeleteResult;
	isBlobPinned(blobId: string, includeStaging?: boolean, now?: number): boolean;
	listBlobsReadyForDeletion(now: number, limit: number): BlobRow[];
	deleteBlobIfCollectible(blobId: string, now?: number): void;
	markBlobPendingDeleteIfUnpinned(blobId: string, now?: number): void;
	nextBlobGcAt(): number | null;
}
