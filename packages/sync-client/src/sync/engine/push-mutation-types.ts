import type { SyncBlobClient } from "../remote/blob-client";
import type { ConflictFileWriter } from "../core/conflict-file";
import type {
  SyncContentRuntimeDeps,
} from "../core/content-runtime";
import type { SyncedEntryMetadata } from "../core/content";
import type { SyncCryptoContext } from "../core/crypto";
import type {
  CommitAcceptedResult,
  CommitMutationPayload,
} from "../remote/realtime-client";
import type {
  SyncBlobStore,
  SyncEntryStore,
  SyncLocalEntryStore,
  SyncMutationStore,
  SyncPushAcceptanceStore,
  SyncRemoteEntryStore,
} from "../store/ports";
import type { SyncProgressCounts } from "../store/store";

export interface PushMutationCommitterDeps extends SyncContentRuntimeDeps {
  getApiBaseUrl: () => string;
  getRemoteVaultKey: () => Uint8Array;
  getSyncCryptoContext?: () => SyncCryptoContext;
  fileReader: LocalFileReader;
  conflictFileWriter?: ConflictFileWriter;
  blobClient: Pick<SyncBlobClient, "uploadBlob">;
  remotelyStagedBlobIds: Set<string>;
  onConflict?: (event: PushConflictEvent) => void;
  now?: () => number;
}

export interface LocalFileReader {
  readBytes(path: string): Promise<Uint8Array>;
  /** Optional stat lookup used to reserve memory before readBytes starts. */
  getFileSize?(path: string): Promise<number>;
}

export interface PushConflictEvent {
  entryId: string;
  op: "upsert" | "delete";
  originalPath: string;
  conflictPath: string | null;
}

export type PushMutationCommitResult =
  | {
      status: "accepted";
      accepted: CommitAcceptedResult;
      filesCreatedOrUpdated: number;
      filesDeleted: number;
      conflictsCreated: 0;
      shouldPullAfterPush: false;
    }
  | {
      status: "requeued";
      filesCreatedOrUpdated: 0;
      filesDeleted: 0;
      conflictsCreated: 0;
      shouldPullAfterPush: false;
    }
  | {
      status: "conflict";
      filesCreatedOrUpdated: 0;
      filesDeleted: 0;
      conflictsCreated: number;
      shouldPullAfterPush: false;
    }
  | {
      status: "stale";
      filesCreatedOrUpdated: 0;
      filesDeleted: 0;
      conflictsCreated: 0;
      shouldPullAfterPush: true;
    };

export interface PreparedPushMutation {
  commitPayload: CommitMutationPayload;
  metadata: SyncedEntryMetadata;
  localHash: string | null;
  encryptedBytes: Uint8Array | null;
  storageBytesAdded: number;
}

export interface PushMutationStore
  extends Pick<SyncEntryStore, "getEntryById">,
    Pick<SyncRemoteEntryStore, "applyRemoteState" | "getRemoteStateById">,
    Pick<SyncLocalEntryStore, "applyLocalState" | "getLocalStateById">,
    Pick<
      SyncMutationStore,
      | "clearDirtyEntryByMutationId"
      | "getDirtyEntryMutation"
      | "replaceDirtyEntry"
      | "updateDirtyEntry"
    >,
    Pick<SyncBlobStore, "putBlob">,
    SyncPushAcceptanceStore {}

export interface SkippedPushMutation {
  skipped: true;
  reason: "file_too_large" | "storage_quota_exceeded";
}

export type PreparePushMutationResult = PreparedPushMutation | SkippedPushMutation | null;

export type PushProgressReporter = (progress: SyncProgressCounts) => Promise<void>;
