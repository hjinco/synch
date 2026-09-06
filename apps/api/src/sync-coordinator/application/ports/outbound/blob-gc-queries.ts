import type { BlobReferenceFacts } from "../../../domain/blob-gc-policy";
import type { BlobRow } from "./storage-models";

export type BlobGcCandidate = BlobRow & { referenceFacts: BlobReferenceFacts };
/** SQL prefilters collectible candidates before LIMIT; facts remain explicit for domain validation. */
export interface BlobGcQueries {
	listCollectibleBlobs(now: number, limit: number): BlobGcCandidate[];
	readCollectibleBlob(blobId: string, now: number): BlobGcCandidate | null;
	readGcDeadlines(now: number): readonly number[];
}
