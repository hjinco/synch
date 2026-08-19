import type {
	CurrentEntryRow,
	DeletedEntryListRow,
	DeletedEntryPageCursor,
	EntryStatePageCursor,
	EntryStateRow,
	EntryVersionListRow,
	EntryVersionPageCursor,
	EntryVersionReason,
	EntryVersionRow,
	PurgeDeletedEntryBatchResult,
} from "../../dto/types";

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
	purgeDeletedEntryVersions(
		entries: Array<{ entryId: string; revision: number }>,
		retentionStart: number,
	): { results: PurgeDeletedEntryBatchResult[]; candidateBlobIds: string[] };
}
