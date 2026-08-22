import type {
	EntryStatePageCursor,
	EntryVersionPageCursor,
} from "../../dto/types";
import type {
	CurrentEntryRow,
	DeletedEntryListRow,
	EntryStateRow,
	EntryVersionListRow,
	EntryVersionRow,
} from "./storage-models";
import type {
	DeletedEntryPageCursor,
} from "../../dto/types";

export type DeletedEntryPurgeFacts = {
	current: { revision: number; deleted: boolean } | null;
	hasRestorableHistory: boolean;
	candidateBlobIds: string[];
};

export interface DeletedEntryPurgeTransaction {
	readFacts(): DeletedEntryPurgeFacts;
	deleteEntryVersions(): void;
}

export interface EntryStateStore {
	listEntryStates(
		sinceCursor: number,
		targetCursor: number,
		after: EntryStatePageCursor | null,
		limit: number,
	): EntryStateRow[];
	countEntryStates(sinceCursor: number, targetCursor: number): number;
	listDeletedEntries(
		before: DeletedEntryPageCursor | null,
		retentionStart: number,
		limit: number,
	): DeletedEntryListRow[];
	readEntry(entryId: string): CurrentEntryRow | null;
}

export interface EntryHistoryStore {
	listEntryVersions(
		entryId: string,
		before: EntryVersionPageCursor | null,
		retentionStart: number,
		limit: number,
	): EntryVersionListRow[];
	readEntryVersion(
		entryId: string,
		versionId: string,
		retentionStart: number,
	): EntryVersionRow | null;
	withDeletedEntryPurgeTransaction<T>(
		entryId: string,
		retentionStart: number,
		operation: (transaction: DeletedEntryPurgeTransaction) => T,
	): T;
}
