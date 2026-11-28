import type { SyncEventRecorder } from "../engine/event-recorder";

type FileOperation = "create" | "modify" | "rename" | "delete";

export interface SyncChangeSourceContext {
  eventRecorder: Pick<
    SyncEventRecorder,
    "recordUpsert" | "recordRename" | "recordDelete"
  > &
    Partial<
      Pick<SyncEventRecorder, "recordUpsertFromFile" | "recordRenameFromFile">
    >;
  notifyLocalChange: () => void;
  runLocalMutationWork: <T>(work: () => Promise<T>, operation?: FileOperation) => Promise<T>;
  hasActiveRemoteVaultSession: () => boolean;
  onError: (error: unknown) => void;
  onFileQueued?: (event: {
    operation: FileOperation;
    path: string;
    oldPath?: string;
  }) => void;
  onFileError?: (event: {
    operation: FileOperation;
    path: string;
    oldPath?: string;
    error: unknown;
  }) => void;
}

export interface SyncChangeSource {
  start(context: SyncChangeSourceContext): void;
}
