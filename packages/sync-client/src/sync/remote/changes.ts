export interface EntryStatePageCursor {
  updatedSeq: number;
  entryId: string;
}

export interface RemoteEntryState {
  entryId: string;
  revision: number;
  blobId: string | null;
  encryptedMetadata: string;
  deleted: boolean;
  updatedSeq: number;
  updatedAt: number;
}

export interface ListEntryStatesResponse {
  targetCursor: number;
  totalEntries: number;
  hasMore: boolean;
  nextAfter: EntryStatePageCursor | null;
  entries: RemoteEntryState[];
}
