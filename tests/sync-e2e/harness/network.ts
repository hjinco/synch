import { createTransport } from "@synch/sync-testkit/transport";

/** E2E opts into wire capture and corruption; benchmark transport does neither. */
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

  private readonly transport = createTransport({
    sent: text => { this.sent.push(text); },
    received: text => { this.received.push(text); },
    beforeSend: text => {
      if (this.hold && JSON.parse(text).type === "commit_mutations") {
        const hold = this.hold;
        this.hold = undefined;
        hold.reached();
        return hold.release;
      }
    },
    beforeRequest: input => {
      if (input.method === "PUT" && input.body instanceof ArrayBuffer) this.uploads.push(new Uint8Array(input.body.slice(0)));
    },
    response: (input, status, buffer) => {
      if (status >= 200 && status < 300 && (!input.method || input.method === "GET") && input.url.includes("/blobs/")) {
        const bytes = new Uint8Array(buffer);
        this.downloads.push(bytes.slice());
        if (this.tamperBlob) bytes[bytes.length - 1] ^= 1;
      }
    },
  }, 10_000);
  readonly httpClient = this.transport.httpClient;
  readonly createWebSocket = this.transport.createWebSocket;
  close() { this.transport.close(); }
}
