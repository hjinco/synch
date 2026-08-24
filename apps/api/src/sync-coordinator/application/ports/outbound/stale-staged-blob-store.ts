import type { BlobRow } from "./storage-models";

export type UnreferencedStagedBlobDeleteResult =
	| "deleted"
	| "missing"
	| "referenced";

export interface StaleStagedBlobStore {
	listStaleStagedBlobs(now: number, staleAfterMs: number, limit: number): BlobRow[];
	deleteUnreferencedStagedBlob(
		blobId: string,
		now?: number,
	): UnreferencedStagedBlobDeleteResult;
}
