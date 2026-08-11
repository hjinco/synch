import { ApiRequestError } from "../http/request";

export type RemoteVaultUnavailableReason = "not_found" | "access_denied";

export class RemoteVaultUnavailableError extends Error {
  constructor(
    readonly remoteVaultId: string,
    readonly reason: RemoteVaultUnavailableReason,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "RemoteVaultUnavailableError";
  }
}

export function remoteVaultUnavailableFromApiError(
  error: unknown,
  remoteVaultId: string,
): RemoteVaultUnavailableError | null {
  if (!(error instanceof ApiRequestError)) {
    return null;
  }

  if (error.status === 404 || error.code === "not_found") {
    return new RemoteVaultUnavailableError(
      remoteVaultId,
      "not_found",
      error.message || "remote vault was not found",
      error,
    );
  }

  if (error.status === 403 || error.code === "forbidden") {
    return new RemoteVaultUnavailableError(
      remoteVaultId,
      "access_denied",
      error.message || "remote vault access is no longer available",
      error,
    );
  }

  return null;
}

export function remoteVaultUnavailableFromWebSocketClose(
  event: { code: number; reason: string },
  remoteVaultId: string,
): RemoteVaultUnavailableError | null {
  if (event.code !== 4403) {
    return null;
  }

  return new RemoteVaultUnavailableError(
    remoteVaultId,
    /deleted|removed|not found/i.test(event.reason) ? "not_found" : "access_denied",
    event.reason || "remote vault access is no longer available",
  );
}

export function isRemoteVaultUnavailableError(
  error: unknown,
): error is RemoteVaultUnavailableError {
  return error instanceof RemoteVaultUnavailableError;
}
