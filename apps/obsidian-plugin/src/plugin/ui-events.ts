export type SynchUiEvent =
  | { type: "sync-status-changed" }
  | { type: "storage-status-changed" }
  | { type: "file-size-blocked-changed" }
  | { type: "sync-log-changed" };
