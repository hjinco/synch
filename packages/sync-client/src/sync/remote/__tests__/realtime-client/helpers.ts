import {
  type CommitMutationPayload,
  type SyncRealtimeClientOptions,
  SyncRealtimeClient,
  type SyncRealtimeCallbacks,
  type SyncRealtimeSession,
} from "../../realtime-client";

export function createMutation(): CommitMutationPayload {
  return {
    mutationId: "mutation-1",
    entryId: "entry-1",
    op: "upsert",
    baseRevision: 0,
    blobId: "blob-1",
    encryptedMetadata: "metadata",
  };
}

export async function openRealtimeSession(input: {
  socket?: MockWebSocket;
  callbacks?: Partial<SyncRealtimeCallbacks>;
  clientOptions?: Partial<SyncRealtimeClientOptions>;
  helloPolicy?: {
    storageLimitBytes: number;
    maxFileSizeBytes: number;
  };
  helloStorageStatus?: {
    storageUsedBytes: number;
    storageLimitBytes: number;
  };
} = {}): Promise<{
  socket: MockWebSocket;
  session: SyncRealtimeSession;
}> {
  const socket = input.socket ?? new MockWebSocket();
  const client = new SyncRealtimeClient(
    {
      create: () => socket.asWebSocket(),
    },
    {
      heartbeatIntervalMs: 0,
      ...input.clientOptions,
    },
  );

  const openPromise = client.openSession(
    "http://127.0.0.1:8787",
    {
      token: "token-1",
      expiresAt: 100,
      vaultId: "vault-1",
      localVaultId: "local-vault-1",
      syncFormatVersion: 1,
    },
    0,
    {
      onCursorAdvanced: input.callbacks?.onCursorAdvanced ?? (() => {}),
      onStorageStatusUpdated: input.callbacks?.onStorageStatusUpdated ?? (() => {}),
      onPolicyUpdated: input.callbacks?.onPolicyUpdated ?? (() => {}),
      onClose: input.callbacks?.onClose ?? (() => {}),
      onError:
        input.callbacks?.onError ??
        ((error) => {
          throw error;
        }),
    },
  );

  socket.emit("open");
  await waitForSentMessage(socket, 0);
  const hello = socket.sentMessageAt(0);
  socket.emitMessage({
    type: "hello_ack",
    requestId: hello.requestId,
    cursor: 0,
    policy: input.helloPolicy ?? {
      storageLimitBytes: 100_000_000,
      maxFileSizeBytes: 3_000_000,
    },
    storageStatus: input.helloStorageStatus ?? {
      storageUsedBytes: 24_300_000,
      storageLimitBytes: 100_000_000,
    },
  });

  return {
    socket,
    session: await openPromise,
  };
}

export async function waitForSentMessage(
  socket: MockWebSocket,
  index: number,
): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (socket.sent.length > index) {
      return;
    }

    await Promise.resolve();
  }

  throw new Error(`expected sent websocket message at index ${index}`);
}

type MockEvent = {
  data?: string;
  code?: number;
  reason?: string;
};

export class MockWebSocket {
  readonly sent: string[] = [];
  failNextSend = false;
  private readonly listeners = new Map<string, Set<(event: MockEvent) => void>>();

  asWebSocket(): WebSocket {
    return this as unknown as WebSocket;
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener as (event: MockEvent) => void);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener as (event: MockEvent) => void);
  }

  send(data: string): void {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error("send failed");
    }

    this.sent.push(data);
  }

  close(): void {
    this.emit("close");
  }

  emit(type: string, event: MockEvent = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  emitMessage(message: object): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  sentMessageAt(index: number): Record<string, unknown> {
    const sent = this.sent[index];
    if (!sent) {
      throw new Error(`expected sent websocket message at index ${index}`);
    }

    return JSON.parse(sent) as Record<string, unknown>;
  }
}
