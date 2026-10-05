import { ApiRequestError } from "../../http/request";

/** A server pause stops sync without revoking the vault link or deleting local state. */
export function isSyncPausedError(error: unknown): error is Error {
  return error instanceof Error && (
    ("code" in error && error.code === "sync_paused") ||
    (error instanceof ApiRequestError && error.code === "forbidden" &&
      error.message === "vault sync is temporarily paused for repair")
  );
}

export function isSyncPausedClose(event: { code: number; reason: string }): boolean {
  return (event.code === 1013 || event.code === 4403) &&
    event.reason === "sync paused for vault repair";
}
