import type {
	BlobMutationFacts,
	BlobMutationTransaction,
} from "./blob-state-store";
import type { BlobRow } from "./storage-models";

export interface StaleStagedBlobStore {
	listStaleStagedBlobs(now: number, staleAfterMs: number, limit: number): BlobRow[];
	withStagedBlobTransaction<T>(
		blobId: string,
		now: number,
		operation: (transaction: StaleStagedBlobTransaction) => T,
	): T;
}

export type StaleStagedBlobFacts = BlobMutationFacts;
export type StaleStagedBlobTransaction = BlobMutationTransaction;
