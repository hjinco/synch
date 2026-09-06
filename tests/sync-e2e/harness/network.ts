import WebSocket from "ws";
import type { HttpClient } from "@synch/sync-client/http";

/** Transport-only controls: server replies and conflict decisions always remain real. */
export class DeviceNetwork {
  readonly sent: string[] = [];
  readonly received: string[] = [];
  readonly uploads: Uint8Array[] = [];
  readonly downloads: Uint8Array[] = [];
  tamperBlob = false;
  private hold: { reached(): void; release: Promise<void> } | undefined;

  holdNextCommit() {
    let reached = false;
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    this.hold = { reached: () => { reached = true; }, release: released };
    return { hasReached: () => reached, release };
  }

  createWebSocket = (url: string, protocols: string[]): globalThis.WebSocket => {
    const socket = new WebSocket(url, protocols);
    socket.on("message", bytes => this.received.push(bytes.toString()));
    const send = socket.send.bind(socket);
    socket.send = (data, ...args: unknown[]) => {
      const text = String(data);
      this.sent.push(text);
      if (this.hold && JSON.parse(text).type === "commit_mutations") {
        const hold = this.hold;
        this.hold = undefined;
        hold.reached();
        void hold.release.then(() => { if (socket.readyState === WebSocket.OPEN) send(data); });
      } else {
        send(data, ...(args as []));
      }
    };
    // ws implements the browser event API consumed by SyncRealtimeClient.
    return socket as unknown as globalThis.WebSocket;
  };

  readonly httpClient: HttpClient = {
    request: async input => {
      if (input.method === "PUT" && input.body instanceof ArrayBuffer) this.uploads.push(new Uint8Array(input.body.slice(0)));
      const response = await fetch(input.url, {
        method: input.method, headers: input.headers, body: input.body, signal: AbortSignal.timeout(10_000),
      });
      let bytes = new Uint8Array(await response.arrayBuffer());
      if (response.ok && (!input.method || input.method === "GET") && input.url.includes("/blobs/")) {
        this.downloads.push(bytes.slice());
        if (this.tamperBlob) { bytes = bytes.slice(); bytes[bytes.length - 1] ^= 1; }
      }
      const text = new TextDecoder().decode(bytes);
      let json: unknown;
      try { json = JSON.parse(text); } catch { /* Binary response. */ }
      return { status: response.status, text, json, arrayBuffer: bytes.buffer as ArrayBuffer };
    },
  };
}
