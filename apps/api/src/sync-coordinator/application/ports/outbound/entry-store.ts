import type {
	InsertEntryVersionInput,
	MutationEntrySnapshot,
	UpsertEntryInput,
} from "./entry-writes";
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
import type { DeletedEntryPageCursor } from "../../dto/types";

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
}

export interface EntryStore extends EntryStateStore {
	readMutationEntry(entryId: string): MutationEntrySnapshot | null;
	upsertEntry(input: UpsertEntryInput): void;
}
export interface EntryVersionStore extends EntryHistoryStore {
	insertEntryVersion(input: InsertEntryVersionInput): boolean;
	hasRestorableHistory(entryId: string, retentionStart: number): boolean;
	listBlobIds(entryId: string): string[];
	deleteEntryVersions(entryId: string): void;
	expireEntryVersions(now: number): void;
}
