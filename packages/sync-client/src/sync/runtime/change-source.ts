import type { SyncEventRecorder } from "../engine/event-recorder";

export interface SyncChangeSourceContext {
  eventRecorder: Pick<
    SyncEventRecorder,
    "recordUpsert" | "recordRename" | "recordDelete"
  > &
    Partial<
      Pick<SyncEventRecorder, "recordUpsertFromFile" | "recordRenameFromFile">
    >;
  notifyLocalChange: () => void;
  runLocalMutationWork: <T>(work: () => Promise<T>) => Promise<T>;
  hasActiveRemoteVaultSession: () => boolean;
  onError: (error: unknown) => void;
  onFileQueued?: (event: {
    operation: "create" | "modify" | "rename" | "delete";
    path: string;
    oldPath?: string;
  }) => void;
  onFileError?: (event: {
    operation: "create" | "modify" | "rename" | "delete";
    path: string;
    oldPath?: string;
    error: unknown;
  }) => void;
}

export interface SyncChangeSource {
  start(context: SyncChangeSourceContext): void;
}
