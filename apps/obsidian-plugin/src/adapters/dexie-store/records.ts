export type {
  BlobRecord,
  EntryRecord,
  PendingMutationOp,
  PendingMutationStatus,
} from "@synch/sync-client/sync/store/entry-record";

export interface MetadataRecord {
  id: string;
  remoteVaultId: string | null;
  lastPulledCursor: number;
  progressSnapshotVersion?: number;
  progressCompletedEntries?: number;
  progressTotalEntries?: number;
}
