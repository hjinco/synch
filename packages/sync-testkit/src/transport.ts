import WebSocket from "ws";
import type { HttpClient, HttpRequestInput } from "@synch/sync-client/http";

export interface TransportHooks {
  beforeSend?(text: string): void | Promise<void>;
  sent?(text: string): void;
  received?(text: string): void;
  beforeRequest?(input: HttpRequestInput): void | Promise<void>;
  response?(input: HttpRequestInput, status: number, body: ArrayBuffer): void;
}

/** Real transport. Bodies are neither copied nor retained unless a hook opts in. */
export function createTransport(hooks: TransportHooks = {}, timeoutMs = 120_000) {
  const sockets = new Set<WebSocket>();
  const abort = new AbortController();
  const httpClient: HttpClient = {
    async request(input) {
      await hooks.beforeRequest?.(input);
      const response = await fetch(input.url, {
        method: input.method, headers: input.headers, body: input.body,
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs)]),
      });
      const arrayBuffer = await response.arrayBuffer();
      hooks.response?.(input, response.status, arrayBuffer);
      if (response.ok && input.url.includes("/blobs/")) return { status: response.status, arrayBuffer };
      const text = new TextDecoder().decode(arrayBuffer);
      let json: unknown;
      try { json = JSON.parse(text); } catch { /* Non-JSON errors remain readable. */ }
      return { status: response.status, text, json, arrayBuffer };
    },
  };
  return {
    httpClient,
    createWebSocket(url: string, protocols: string[]): globalThis.WebSocket {
      const socket = new WebSocket(url, protocols);
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("message", bytes => hooks.received?.(bytes.toString()));
      const send = socket.send.bind(socket);
      socket.send = (data, ...args: unknown[]) => {
        const text = String(data);
        hooks.sent?.(text);
        const pending = hooks.beforeSend?.(text);
        if (pending) {
          void pending.then(() => {
            if (socket.readyState === WebSocket.OPEN) send(data, ...(args as []));
          }).catch(error => socket.emit("error", error));
        } else send(data, ...(args as []));
      };
      return socket as unknown as globalThis.WebSocket;
    },
    close() {
      abort.abort();
      for (const socket of sockets) socket.terminate();
      sockets.clear();
    },
  };
}
