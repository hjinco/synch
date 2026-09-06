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

export type InsertEntryVersionInput = {
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
};
export type UpsertEntryInput = {
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
};
