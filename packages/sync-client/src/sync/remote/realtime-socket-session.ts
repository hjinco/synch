import type { EntryStatePageCursor } from "./changes";
import type {
  CommitMutationPayload,
  DeletedEntryPageCursor,
  EntryVersionPageCursor,
  PurgeDeletedEntryPayload,
  RestoreEntryVersionPayload,
  ServerMessage,
  SyncRealtimeCallbacks,
  SyncRealtimeClientOptions,
} from "./realtime-types";
import { SyncRealtimeConnectionError, SyncRealtimeError } from "./realtime-types";
import { remoteVaultUnavailableFromWebSocketClose } from "../../remote-vault/unavailable";

type ClientMessage =
  | {
      type: "hello";
      requestId: string;
      lastKnownCursor: number;
    }
  | {
      type: "commit_mutations";
      requestId: string;
      mutations: CommitMutationPayload[];
    }
  | {
      type: "list_entry_states";
      requestId: string;
      sinceCursor: number;
      targetCursor: number | null;
      after: EntryStatePageCursor | null;
      limit: number;
    }
  | {
      type: "list_entry_versions";
      requestId: string;
      entryId: string;
      before: EntryVersionPageCursor | null;
      limit: number;
    }
  | {
      type: "list_deleted_entries";
      requestId: string;
      before: DeletedEntryPageCursor | null;
      limit: number;
    }
  | {
      type: "restore_entry_version";
      requestId: string;
    } & RestoreEntryVersionPayload
  | {
      type: "restore_entry_versions";
      requestId: string;
      restores: RestoreEntryVersionPayload[];
    }
  | {
      type: "purge_deleted_entries";
      requestId: string;
      entries: PurgeDeletedEntryPayload[];
    }
  | {
      type: "detach_local_vault";
      requestId: string;
    }
  | {
      type: "heartbeat";
      requestId: string;
    }
  | {
      type: "watch_storage_status";
    }
  | {
      type: "unwatch_storage_status";
    };

type RequestClientMessage = Extract<ClientMessage, { requestId: string }>;
type RequestClientMessageInput = RequestClientMessage extends infer Message
  ? Message extends { requestId: string }
    ? Omit<Message, "requestId">
    : never
  : never;

type PendingRequest = {
  resolve(message: ServerMessage): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof globalThis.setTimeout> | null;
};

export class SyncRealtimeSocketSession {
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private heartbeatTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private closed = false;
  private receivedSessionError = false;
  private nextRequestId = 0;

  constructor(
    private readonly socket: WebSocket,
    private readonly callbacks: SyncRealtimeCallbacks,
    private readonly options: SyncRealtimeClientOptions,
  ) {
    socket.addEventListener("message", this.handleMessage as EventListener);
    socket.addEventListener("error", this.handleError);
    socket.addEventListener("close", this.handleClose);
  }

  startHeartbeat(): void {
    if (this.options.heartbeatIntervalMs <= 0 || this.heartbeatTimer) {
      return;
    }

    this.heartbeatTimer = globalThis.setInterval(() => {
      void this.sendHeartbeat();
    }, this.options.heartbeatIntervalMs);
  }

  async request(
    message: RequestClientMessageInput,
    timeoutMs = this.options.requestTimeoutMs,
    reportConnectionError = false,
  ): Promise<ServerMessage> {
    return await this.sendAndAwait(
      {
        ...message,
        requestId: this.createRequestId(),
      },
      timeoutMs,
      reportConnectionError,
    );
  }

  private createRequestId(): string {
    this.nextRequestId += 1;
    return `sync-request-${this.nextRequestId}`;
  }

  private async sendAndAwait(
    message: RequestClientMessage,
    timeoutMs = this.options.requestTimeoutMs,
    reportConnectionError = false,
  ): Promise<ServerMessage> {
    return await new Promise<ServerMessage>((resolve, reject) => {
      if (this.closed) {
        reject(new SyncRealtimeConnectionError("sync websocket is not connected"));
        return;
      }

      const timeout =
        timeoutMs > 0
          ? globalThis.setTimeout(() => {
              if (!this.pendingRequests.has(message.requestId)) {
                return;
              }

              this.failConnection(
                new SyncRealtimeConnectionError("sync websocket request timed out"),
                reportConnectionError,
              );
            }, timeoutMs)
          : null;
      this.pendingRequests.set(message.requestId, { resolve, reject, timeout });
      try {
        this.socket.send(JSON.stringify(message));
      } catch (error) {
        this.failConnection(
          new SyncRealtimeConnectionError(toErrorMessage(error), {
            cause: error,
          }),
          reportConnectionError,
        );
      }
    });
  }

  send(message: ClientMessage): void {
    if (this.closed) {
      throw new SyncRealtimeConnectionError("sync websocket is not connected");
    }

    try {
      this.socket.send(JSON.stringify(message));
    } catch (error) {
      const connectionError = new SyncRealtimeConnectionError(toErrorMessage(error), {
        cause: error,
      });
      this.failConnection(connectionError, false);
      throw connectionError;
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.stopHeartbeat();
    this.socket.removeEventListener("message", this.handleMessage as EventListener);
    this.socket.removeEventListener("error", this.handleError);
    this.socket.removeEventListener("close", this.handleClose);
    this.rejectPending(
      new SyncRealtimeConnectionError(
        "sync websocket closed before the request completed",
      ),
    );
    try {
      this.socket.close();
    } catch {
      // The session is already being torn down.
    }
  }

  private readonly handleMessage = (event: MessageEvent<string>): void => {
    if (this.closed) {
      return;
    }

    let parsed: ServerMessage;
    try {
      parsed = JSON.parse(event.data) as ServerMessage;
    } catch {
      this.callbacks.onError(new Error("sync websocket returned invalid JSON"));
      return;
    }

    if (parsed.type === "cursor_advanced") {
      this.callbacks.onCursorAdvanced(parsed.cursor);
      return;
    }

    if (parsed.type === "storage_status_updated") {
      this.callbacks.onStorageStatusUpdated(parsed.storageStatus);
      return;
    }

    if (parsed.type === "policy_updated") {
      this.callbacks.onPolicyUpdated(parsed.policy, parsed.storageStatus);
      return;
    }

    if (parsed.type === "session_error") {
      this.receivedSessionError = true;
      const error = new SyncRealtimeError(parsed.code, parsed.message);
      this.rejectPending(error);
      this.callbacks.onError(error);
      return;
    }

    const request = this.pendingRequests.get(parsed.requestId);
    if (!request) {
      this.callbacks.onError(
        new Error(`sync websocket returned a response for unknown request ${parsed.requestId}`),
      );
      return;
    }

    this.pendingRequests.delete(parsed.requestId);
    this.clearPendingTimeout(request);
    if (
      parsed.type === "commit_rejected" ||
      parsed.type === "commit_mutations_failed" ||
      parsed.type === "entry_states_list_failed" ||
      parsed.type === "entry_versions_list_failed" ||
      parsed.type === "deleted_entries_list_failed" ||
      parsed.type === "entry_restore_failed" ||
      parsed.type === "deleted_entries_purge_failed"
    ) {
      request.reject(new SyncRealtimeError(parsed.code, parsed.message));
      return;
    }

    request.resolve(parsed);
  };

  private readonly handleError = (): void => {
    this.failConnection(
      new SyncRealtimeConnectionError("sync websocket connection failed"),
    );
  };

  private readonly handleClose = (event: CloseEvent): void => {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.stopHeartbeat();
    const sessionError = syncRealtimeErrorFromCloseEvent(event);
    this.rejectPending(
      sessionError ??
        new SyncRealtimeConnectionError(
          "sync websocket closed before the request completed",
        ),
    );
    if (sessionError && !this.receivedSessionError) {
      this.callbacks.onError(sessionError);
    }
    this.callbacks.onClose({
      code: event.code,
      reason: event.reason,
    });
  };

  private async sendHeartbeat(): Promise<void> {
    try {
      const message = await this.request(
        {
          type: "heartbeat",
        },
        this.options.heartbeatTimeoutMs,
        true,
      );
      if (message.type !== "heartbeat_ack") {
        throw new Error("heartbeat did not produce a heartbeat_ack response");
      }
    } catch (error) {
      if (!this.closed) {
        this.failConnection(toConnectionError(error), true);
      }
    }
  }

  private failConnection(error: Error, reportError = true): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.stopHeartbeat();
    this.socket.removeEventListener("message", this.handleMessage as EventListener);
    this.socket.removeEventListener("error", this.handleError);
    this.socket.removeEventListener("close", this.handleClose);
    this.rejectPending(error);
    if (reportError) {
      this.callbacks.onError(error);
    }
    this.callbacks.onClose({
      code: 0,
      reason: error.message,
    });
    try {
      this.socket.close();
    } catch {
      // The connection may already be closed by the platform.
    }
  }

  private rejectPending(error: Error): void {
    const pending = Array.from(this.pendingRequests.values());
    this.pendingRequests.clear();
    for (const request of pending) {
      this.clearPendingTimeout(request);
      request.reject(error);
    }
  }

  private clearPendingTimeout(request: PendingRequest): void {
    if (request.timeout) {
      globalThis.clearTimeout(request.timeout);
    }
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) {
      return;
    }

    globalThis.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}

export async function waitForOpen(
  socket: WebSocket,
  remoteVaultId: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new SyncRealtimeConnectionError("sync websocket connection failed"));
    };
    const onClose = (event: CloseEvent) => {
      cleanup();
      const unavailable = remoteVaultUnavailableFromWebSocketClose(
        {
          code: event.code,
          reason: event.reason,
        },
        remoteVaultId,
      );
      if (unavailable) {
        reject(unavailable);
        return;
      }

      const sessionError = syncRealtimeErrorFromCloseEvent(event);
      if (sessionError) {
        reject(sessionError);
        return;
      }

      reject(
        new SyncRealtimeConnectionError(
          "sync websocket closed before the session started",
        ),
      );
    };

    const cleanup = () => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };

    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
  });
}

function toConnectionError(error: unknown): SyncRealtimeConnectionError {
  if (error instanceof SyncRealtimeConnectionError) {
    return error;
  }

  return new SyncRealtimeConnectionError(toErrorMessage(error), {
    cause: error,
  });
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function syncRealtimeErrorFromCloseEvent(event: {
  code: number;
  reason: string;
}): SyncRealtimeError | null {
  if (event.code !== 4409) {
    return null;
  }

  return new SyncRealtimeError(
    "local_vault_replaced",
    event.reason || "connection replaced by a newer sync session for this local vault",
  );
}
