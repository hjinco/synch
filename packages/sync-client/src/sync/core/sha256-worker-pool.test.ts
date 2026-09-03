import { describe, expect, it } from "vitest";

import { encodeUtf8 } from "./content";
import {
  Sha256WorkerPool,
  type Sha256WorkerLike,
} from "./sha256-worker-pool";

type HashMessage = { id: number; buffer: ArrayBuffer };
type HashResponse =
  | { id: number; digest: ArrayBuffer; buffer: ArrayBuffer }
  | { id: number; error: { name?: string; message?: string } };
type MessageListener = (event: MessageEvent<HashResponse>) => void;
type ErrorListener = (event: ErrorEvent | MessageEvent) => void;

interface WorkerTracker {
  active: number;
  maxActive: number;
}

class FakeHashWorker implements Sha256WorkerLike {
  private readonly messageListeners: MessageListener[] = [];
  private readonly errorListeners: ErrorListener[] = [];
  private readonly pending: HashMessage[] = [];

  constructor(private readonly tracker: WorkerTracker) {}

  postMessage(message: HashMessage, transfer: Transferable[] = []): void {
    if (!transfer.includes(message.buffer)) {
      throw new Error("hash input was not transferred");
    }

    this.pending.push(message);
    this.tracker.active += 1;
    this.tracker.maxActive = Math.max(this.tracker.maxActive, this.tracker.active);
  }

  addEventListener(type: "message", listener: MessageListener): void;
  addEventListener(type: "error" | "messageerror", listener: ErrorListener): void;
  addEventListener(
    type: "message" | "error" | "messageerror",
    listener: MessageListener | ErrorListener,
  ): void {
    if (type === "message") {
      this.messageListeners.push(listener as MessageListener);
    } else {
      this.errorListeners.push(listener as ErrorListener);
    }
  }

  removeEventListener(type: "message", listener: MessageListener): void;
  removeEventListener(type: "error" | "messageerror", listener: ErrorListener): void;
  removeEventListener(
    type: "message" | "error" | "messageerror",
    listener: MessageListener | ErrorListener,
  ): void {
    const listeners = type === "message" ? this.messageListeners : this.errorListeners;
    const index = listeners.indexOf(listener as never);
    if (index >= 0) {
      listeners.splice(index, 1);
    }
  }

  terminate(): void {
    this.pending.length = 0;
  }

  async completeNext(): Promise<void> {
    const message = this.pending.shift();
    if (!message) {
      throw new Error("no pending hash job");
    }

    const digest = await crypto.subtle.digest("SHA-256", message.buffer);
    this.tracker.active -= 1;
    const event = {
      data: {
        id: message.id,
        digest,
        buffer: message.buffer,
      },
    } as MessageEvent<HashResponse>;
    for (const listener of this.messageListeners) {
      listener(event);
    }
  }

  failNextResponse(message = "hash failed"): void {
    const job = this.pending.shift();
    if (!job) {
      throw new Error("no pending hash job");
    }

    this.tracker.active -= 1;
    const event = {
      data: {
        id: job.id,
        error: { name: "HashError", message },
      },
    } as MessageEvent<HashResponse>;
    for (const listener of this.messageListeners) {
      listener(event);
    }
  }

  failWorker(message = "worker failed"): void {
    if (this.pending.length > 0) {
      this.pending.shift();
      this.tracker.active -= 1;
    }

    const event = { message } as ErrorEvent;
    for (const listener of this.errorListeners) {
      listener(event);
    }
  }
}

describe("Sha256WorkerPool", () => {
  it("keeps hashing bounded and continues queued jobs", async () => {
    const tracker: WorkerTracker = { active: 0, maxActive: 0 };
    const workers: FakeHashWorker[] = [];
    const pool = new Sha256WorkerPool({
      concurrency: 2,
      createWorker: () => {
        const worker = new FakeHashWorker(tracker);
        workers.push(worker);
        return worker;
      },
    });

    const first = pool.hashAndReturnBytes(encodeUtf8("one"));
    const second = pool.hashAndReturnBytes(encodeUtf8("two"));
    const third = pool.hashAndReturnBytes(encodeUtf8("three"));
    await Promise.resolve();

    expect(tracker.active).toBe(2);
    expect(tracker.maxActive).toBe(2);

    await workers[0]?.completeNext();
    await Promise.resolve();
    expect(tracker.active).toBe(2);

    await workers[1]?.completeNext();
    await workers[0]?.completeNext();

    await expect(first).resolves.toMatchObject({
      hash: "7692c3ad3540bb803c020b3aee66cd8887123234ea0c6e7143c0add73ff431ed",
    });
    await expect(second).resolves.toMatchObject({
      hash: "3fc4ccfe745870e2c0d99f71f30ff0656c8dedd41cc1d7d3d376b0dbe685e2f3",
    });
    await expect(third).resolves.toMatchObject({
      hash: "8b5b9db0c13db24256c829aa364aa90c6d2eba318b9232a4ab9313b954d3555f",
    });
    pool.dispose();
  });

  it("propagates a worker response error to the right request", async () => {
    const tracker: WorkerTracker = { active: 0, maxActive: 0 };
    const workers: FakeHashWorker[] = [];
    const pool = new Sha256WorkerPool({
      concurrency: 1,
      createWorker: () => {
        const worker = new FakeHashWorker(tracker);
        workers.push(worker);
        return worker;
      },
    });

    const failed = pool.hash(encodeUtf8("failed"));
    const continued = pool.hash(encodeUtf8("continued"));
    await Promise.resolve();
    workers[0]?.failNextResponse();

    await expect(failed).rejects.toMatchObject({
      name: "HashError",
      message: "hash failed",
    });
    await workers[0]?.completeNext();
    await expect(continued).resolves.toBe(
      "0dec6069d55174d6223c08b49a7cfc291aefc5cd366d7c8f7b0606325e92e6ea",
    );
    pool.dispose();
  });

  it("replaces a failed worker so queued requests do not remain pending", async () => {
    const tracker: WorkerTracker = { active: 0, maxActive: 0 };
    const workers: FakeHashWorker[] = [];
    const pool = new Sha256WorkerPool({
      concurrency: 1,
      createWorker: () => {
        const worker = new FakeHashWorker(tracker);
        workers.push(worker);
        return worker;
      },
    });

    const failed = pool.hash(encodeUtf8("failed"));
    const continued = pool.hash(encodeUtf8("continued"));
    await Promise.resolve();
    workers[0]?.failWorker();

    await expect(failed).rejects.toThrow("worker failed");
    expect(workers).toHaveLength(2);
    await workers[1]?.completeNext();
    await expect(continued).resolves.toBe(
      "0dec6069d55174d6223c08b49a7cfc291aefc5cd366d7c8f7b0606325e92e6ea",
    );
    pool.dispose();
  });
});
