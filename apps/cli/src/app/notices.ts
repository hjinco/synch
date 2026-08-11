import type { AuthNoticeEvent } from "@synch/sync-client/auth/manager";
import type { RemoteVaultNoticeEvent } from "@synch/sync-client/remote-vault/manager";
import type { UserVisibleSyncState } from "@synch/sync-client/sync/runtime/user-visible-status";

export interface Logger {
  log(message: string): void;
  error(message: string): void;
}

export const consoleLogger: Logger = {
  log(message) {
    process.stderr.write(`${message}\n`);
  },
  error(message) {
    process.stderr.write(`error: ${message}\n`);
  },
};

export function formatAuthNotice(event: AuthNoticeEvent): string {
  switch (event.type) {
    case "device_sign_in_starting":
      return "Starting device sign-in...";
    case "opening_browser":
      return `Confirm the code in your browser: ${event.code}`;
    case "approval_received":
      return "Approval received. Finishing sign-in...";
    case "signed_in":
      return "Signed in.";
    case "device_sign_in_failed":
      return `Sign-in failed: ${event.message}`;
    case "device_sign_in_expired":
      return "Sign-in request expired. Run `synch login` again.";
    case "device_sign_in_canceled":
      return "Sign-in canceled.";
    case "signed_out":
      return "Signed out.";
  }
}

export function formatRemoteVaultNotice(event: RemoteVaultNoticeEvent): string {
  switch (event.type) {
    case "created_connected":
      return `Created and connected vault "${event.label}".`;
    case "connected":
      return `Connected to vault "${event.label}".`;
    case "disconnected":
      return `Disconnected from vault "${event.label}".`;
  }
}

export function formatSyncConflictNotice(event: {
  op: "upsert" | "delete";
  reason?: "local_pending_mutation" | "remote_path_collision";
  originalPath: string;
  conflictPath: string | null;
}): string {
  if (event.reason === "remote_path_collision" && event.conflictPath) {
    return `Path collision; local copy saved as ${event.conflictPath}`;
  }

  if (event.op === "upsert" && event.conflictPath) {
    return `Conflict on ${event.originalPath}; local copy saved as ${event.conflictPath}`;
  }

  return `Conflict on ${event.originalPath}; remote version kept`;
}

export function formatSyncStatusLabel(state: UserVisibleSyncState): string {
  switch (state) {
    case "not_ready":
      return "not ready";
    case "paused":
      return "paused";
    case "pending":
      return "pending changes";
    case "syncing":
      return "syncing";
    case "offline":
      return "offline";
    case "reconnecting":
      return "reconnecting";
    case "up_to_date":
      return "up to date";
    case "attention_needed":
      return "attention needed";
  }
}
