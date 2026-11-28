import type { FileTransferLog } from "../diagnostics/file-transfer";
import type { SyncDiagnostics } from "../diagnostics/types";
import type { SyncBlobClient } from "../remote/blob-client";
import type { ConflictFileWriter } from "../core/conflict-file";
import type {
  SyncContentRuntimeDeps,
} from "../core/content-runtime";
import type { SyncedEntryMetadata } from "../core/content";
import type { SyncCryptoContext } from "../core/crypto";
import type { CommitMutationPayload } from "../remote/realtime-client";
import type {
  SyncBlobStore,
  SyncEntryStore,
  SyncLocalEntryStore,
  SyncMutationStore,
  SyncPushAcceptanceStore,
  SyncRemoteEntryStore,
} from "../store/ports";
import type { PushBlobRetryCache } from "./push-blob-retry-cache";
import type { SyncVaultPathExclusions } from "../vault/ports";

export interface PushMutationCommitterDeps extends SyncContentRuntimeDeps {
  diagnostics?: SyncDiagnostics;
  getRemoteVaultKey: () => Uint8Array;
  getSyncCryptoContext?: () => SyncCryptoContext;
  isDeviceMutationExcluded?: (path: string) => boolean;
  assertUploadAllowed?: (path: string) => void;
  fileReader: LocalFileReader;
  conflictFileWriter?: ConflictFileWriter;
  blobClient: Pick<SyncBlobClient, "uploadBlob">;
  remotelyStagedBlobIds: Set<string>;
  blobRetryCache?: PushBlobRetryCache;
  onConflict?: (event: PushConflictEvent) => void;
  now?: () => number;
}

export interface LocalFileReader extends SyncVaultPathExclusions {
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

export type PushMutationRejectionResult =
  | {
      status: "conflict";
      conflictsCreated: number;
      shouldPullAfterPush: false;
    }
  | {
      status: "stale";
      conflictsCreated: 0;
      shouldPullAfterPush: true;
    };

export interface PreparedPushMutation {
  transfer?: FileTransferLog;
  commitPayload: CommitMutationPayload;
  metadata: SyncedEntryMetadata;
  localHash: string | null;
  encryptedBytes: Uint8Array | null;
  release?: () => void;
}

export interface PushMutationStore
  extends Pick<SyncEntryStore, "getEntryById" | "getEntryByPath">,
    Pick<SyncRemoteEntryStore, "applyRemoteState" | "getRemoteStateById">,
    Pick<SyncLocalEntryStore, "applyLocalState" | "getLocalStateById" | "clearLocalState">,
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
  reason: "file_too_large" | "incompatible_path" | "storage_quota_exceeded" | "excluded_path";
}

export type PreparePushMutationResult = PreparedPushMutation | SkippedPushMutation | null;
