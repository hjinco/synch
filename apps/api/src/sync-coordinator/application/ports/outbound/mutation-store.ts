import type {
	SocketSession,
} from "../../dto/types";
import type { BlobState } from "./storage-models";
import type { EntryVersionReason } from "./storage-models";

export type MutationEntrySnapshot = {
	entryId: string;
	revision: number;
	blobId: string | null;
	encryptedMetadata: string;
	deleted: boolean;
	updatedSeq: number;
	lastMutationId: string | null;
};

export interface MutationTransaction {
	readEntry(entryId: string): MutationEntrySnapshot | null;
	readBlobState(blobId: string): BlobState | null;
	restagePendingDeleteBlob(blobId: string, deleteAfter: number): void;
	insertEntryVersion(input: {
		versionId: string;
		entryId: string;
		sourceRevision: number;
		opType: "upsert" | "delete";
		blobId: string | null;
		encryptedMetadata: string;
		reason: EntryVersionReason;
		bucketStartMs: number | null;
		createdAt: number;
		expiresAt: number;
		createdByUserId: string;
		createdByLocalVaultId: string;
		ignoreConflict?: boolean;
	}): boolean;
	readCurrentCursor(vaultId: string): number;
	allocateCursor(vaultId: string): number;
	upsertEntry(input: {
		entryId: string;
		revision: number;
		blobId: string | null;
		encryptedMetadata: string;
		deleted: boolean;
		updatedSeq: number;
		updatedAt: number;
		updatedByUserId: string;
		updatedByLocalVaultId: string;
		lastMutationId: string;
	}): void;
	markBlobLive(blobId: string): void;
	markBlobPendingDeleteIfUnreferenced(blobId: string, deleteAfter: number): void;
	finalizeCommit(now: number): void;
}

export interface MutationStore {
	withTransaction<T>(operation: (transaction: MutationTransaction) => T): T;
}

export interface MutationCommitter {
	commitMutation(
		session: SocketSession,
		message: import("../../dto/types").CommitMutationMessage,
		options?: { forcedHistoryBefore?: "before_restore" | null },
	): Promise<import("../../dto/types").CommitMutationResult>;
	commitMutations(
		session: SocketSession,
		message: import("../../dto/types").CommitMutationsMessage,
		options?: { forcedHistoryBefore?: "before_restore" | null },
	): Promise<import("../../dto/types").CommitMutationsResult>;
}
