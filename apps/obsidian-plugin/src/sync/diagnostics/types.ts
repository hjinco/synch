export type SyncDiagnosticSource =
  | "startup"
  | "manual"
  | "periodic"
  | "local_change"
  | "reconnect";

export type SyncFailurePhase =
  | "store_initialization"
  | "auto_sync_initialization"
  | "auto_sync_resume"
  | "auto_sync"
  | "sync_event_handling"
  | "file_rule_update"
  | "local_state_reset"
  | "hidden_folder_scan";

export type SyncDiagnosticConnectionState =
  | "connecting"
  | "live"
  | "reconnecting";

export type SyncDiagnosticErrorClassification =
  | "offline"
  | "remote_vault_unavailable"
  | "storage_quota_exceeded"
  | "unexpected";

export type SyncDiagnosticFileOperation =
  | "create"
  | "modify"
  | "rename"
  | "delete"
  | "upsert";

export type SyncDiagnosticFileDirection = "upload" | "download";

export type SyncDiagnosticEvent =
  | {
      type: "sync_started";
      source: SyncDiagnosticSource;
    }
  | {
      type: "sync_reconciled";
      source: SyncDiagnosticSource;
      filesScanned: number;
      filesQueuedForUpsert: number;
      filesQueuedForDelete: number;
    }
  | {
      type: "sync_completed";
      source: SyncDiagnosticSource;
    }
  | {
      type: "connection_state_changed";
      state: SyncDiagnosticConnectionState;
    }
  | {
      type: "work_scheduled";
      mode: "immediate" | "deferred";
    }
  | {
      type: "retry_scheduled";
      attempt: number;
      delayMs: number;
    }
  | {
      type: "remote_vault_unavailable";
      reason: "not_found" | "access_denied" | "unknown";
    }
  | {
      type: "storage_quota_exceeded";
    }
  | {
      type: "rollback_rejected";
      localRevision: number;
      remoteRevision: number;
    }
  | {
      type: "local_file_queued";
      operation: SyncDiagnosticFileOperation;
      path: string;
      oldPath?: string;
    }
  | {
      type: "file_sync_started";
      direction: SyncDiagnosticFileDirection;
      operation: "upsert" | "delete";
      path: string;
    }
  | {
      type: "file_sync_completed";
      direction: SyncDiagnosticFileDirection;
      operation: "upsert" | "delete";
      path: string;
      revision?: number;
    }
  | {
      type: "file_sync_failed";
      direction: SyncDiagnosticFileDirection | "local";
      operation: SyncDiagnosticFileOperation;
      path: string;
      oldPath?: string;
      reason: string;
    };

export interface SyncDiagnosticError {
  phase: SyncFailurePhase;
  classification?: SyncDiagnosticErrorClassification;
  error: unknown;
}

export interface SyncDiagnosticsSnapshot {
  count: number;
  text: string;
}

export interface SyncDiagnostics {
  record(event: SyncDiagnosticEvent): void;
  recordError(input: SyncDiagnosticError): void;
  clear(): void;
  getSnapshot(): SyncDiagnosticsSnapshot;
  subscribe(listener: () => void): () => void;
}
