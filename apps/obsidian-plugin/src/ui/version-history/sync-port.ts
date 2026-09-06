import type {
  DeletedEntryPageCursor,
  EntryVersion,
  EntryVersionPageCursor,
} from "@synch/sync-client/remote";
import type {
  SyncDeletedEntriesPage,
  SyncDeletedEntriesPurgeResult,
  SyncDeletedEntriesRestoreResult,
  SyncEntryVersionPreview,
  SyncEntryVersionsPage,
} from "@synch/sync-client/engine";

// Minimal port of SyncController required by the version history UI.
export interface VersionHistorySyncPort {
  listEntryVersionsForPath(
    path: string,
    before: EntryVersionPageCursor | null,
    limit: number,
  ): Promise<SyncEntryVersionsPage | null>;
  previewEntryVersionForPath(
    path: string,
    version: EntryVersion,
  ): Promise<SyncEntryVersionPreview>;
  restoreEntryVersionForPath(path: string, version: EntryVersion): Promise<void>;
  listDeletedEntries(
    before: DeletedEntryPageCursor | null,
    limit: number,
  ): Promise<SyncDeletedEntriesPage>;
  restoreDeletedEntries(
    entries: Array<{ entryId: string; revision: number }>,
  ): Promise<SyncDeletedEntriesRestoreResult>;
  purgeDeletedEntries(
    entries: Array<{ entryId: string; revision: number }>,
  ): Promise<SyncDeletedEntriesPurgeResult>;
  previewDeletedEntry(
    entryId: string,
    fallbackPath: string,
  ): Promise<SyncEntryVersionPreview>;
}
