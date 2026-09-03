import {
  createDefaultContentHasher,
  type SyncContentHasher,
} from "./content";
import type { HashedBytes } from "./content";

export const HASH_CONCURRENCY = Math.max(
  1,
  Math.min(
    4,
    Math.floor(
      (typeof navigator === "undefined"
        ? 4
        : (navigator.hardwareConcurrency ?? 4)) / 2,
    ),
  ),
);

interface HashWorkerRequest {
  id: number;
  buffer: ArrayBuffer;
  returnBuffer: boolean;
}

interface HashWorkerSuccess {
  id: number;
  digest: ArrayBuffer;
  buffer?: ArrayBuffer;
}

interface HashWorkerFailure {
  id: number;
  error: {
    name?: string;
    message?: string;
  };
}

type HashWorkerResponse = HashWorkerSuccess | HashWorkerFailure;

export interface Sha256WorkerLike {
  postMessage(message: HashWorkerRequest, transfer?: Transferable[]): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<HashWorkerResponse>) => void,
  ): void;
  addEventListener(
    type: "error" | "messageerror",
    listener: (event: ErrorEvent | MessageEvent) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<HashWorkerResponse>) => void,
  ): void;
  removeEventListener(
    type: "error" | "messageerror",
    listener: (event: ErrorEvent | MessageEvent) => void,
  ): void;
  terminate(): void;
}

export interface Sha256WorkerPoolOptions {
  concurrency?: number;
  createWorker?: () => Sha256WorkerLike;
}

interface HashJob {
  id: number;
  buffer: ArrayBuffer;
  returnBuffer: boolean;
  resolve: (result: HashedBytes) => void;
  reject: (reason?: unknown) => void;
}

interface WorkerSlot {
  worker: Sha256WorkerLike;
  job: HashJob | null;
  onMessage: (event: MessageEvent<HashWorkerResponse>) => void;
  onError: (event: ErrorEvent | MessageEvent) => void;
}

/**
 * A fixed-size pool of workers dedicated to SHA-256. The worker also returns
 * the input buffer so callers that still need the bytes can transfer ownership
 * through the hash operation without making a second full-file copy.
 */
export class Sha256WorkerPool implements SyncContentHasher {
  private readonly workerFactory: () => Sha256WorkerLike;
  private readonly workerSourceUrl: string | null;
  private readonly slots: WorkerSlot[] = [];
  private readonly queuedJobs: HashJob[] = [];
  private nextJobId = 1;
  private disposedError: Error | null = null;
  private workerCreationError: Error | null = null;

  constructor(options: Sha256WorkerPoolOptions = {}) {
    const workerSetup = options.createWorker
      ? {
          createWorker: options.createWorker,
          sourceUrl: null,
        }
      : createDefaultWorkerSetup();
    this.workerFactory = workerSetup.createWorker;
    this.workerSourceUrl = workerSetup.sourceUrl;

    const concurrency = normalizeConcurrency(
      options.concurrency ?? HASH_CONCURRENCY,
      HASH_CONCURRENCY,
    );

    try {
      for (let index = 0; index < concurrency; index += 1) {
        this.slots.push(this.createSlot());
      }
    } catch (error) {
      this.disposeWorkers();
      this.revokeWorkerSourceUrl();
      throw error;
    }
  }

  async hash(bytes: Uint8Array): Promise<string> {
    // Keep the public hash(bytes) behavior non-destructive. Callers that can
    // transfer ownership should use hashAndReturnBytes instead.
    const buffer = copyBytesToArrayBuffer(bytes);
    const result = await this.enqueue(buffer, false);
    return result.hash;
  }

  async hashAndReturnBytes(bytes: Uint8Array): Promise<HashedBytes> {
    const buffer = transferableBytesBuffer(bytes);
    return await this.enqueue(buffer, true);
  }

  dispose(reason: unknown = new Error("SHA-256 worker pool was disposed.")): void {
    if (this.disposedError) {
      return;
    }

    this.disposedError = toError(reason);
    while (this.queuedJobs.length > 0) {
      this.queuedJobs.shift()?.reject(this.disposedError);
    }

    for (const slot of this.slots) {
      if (slot.job) {
        const job = slot.job;
        slot.job = null;
        job.reject(this.disposedError);
      }
    }

    this.disposeWorkers();
    this.revokeWorkerSourceUrl();
  }

  private enqueue(buffer: ArrayBuffer, returnBuffer: boolean): Promise<HashedBytes> {
    if (this.disposedError) {
      return Promise.reject(this.disposedError);
    }
    if (this.workerCreationError) {
      return Promise.reject(this.workerCreationError);
    }

    return new Promise<HashedBytes>((resolve, reject) => {
      this.queuedJobs.push({
        id: this.nextJobId++,
        buffer,
        returnBuffer,
        resolve,
        reject,
      });
      this.pump();
    });
  }

  private createSlot(): WorkerSlot {
    const slot = {
      worker: this.workerFactory(),
      job: null,
      onMessage: null as unknown as WorkerSlot["onMessage"],
      onError: null as unknown as WorkerSlot["onError"],
    } satisfies WorkerSlot;

    this.attachWorker(slot);
    return slot;
  }

  private attachWorker(slot: WorkerSlot): void {
    const worker = slot.worker;
    slot.onMessage = (event) => {
      if (slot.worker !== worker) {
        return;
      }
      this.handleWorkerMessage(slot, event.data);
    };
    slot.onError = (event) => {
      if (slot.worker !== worker) {
        return;
      }
      this.handleWorkerFailure(slot, workerError(event));
    };
    slot.worker.addEventListener("message", slot.onMessage);
    slot.worker.addEventListener("error", slot.onError);
    slot.worker.addEventListener("messageerror", slot.onError);
  }

  private pump(): void {
    if (this.disposedError || this.workerCreationError) {
      return;
    }

    for (const slot of this.slots) {
      if (slot.job || this.queuedJobs.length === 0) {
        continue;
      }

      const job = this.queuedJobs.shift();
      if (!job) {
        continue;
      }

      slot.job = job;
      try {
        slot.worker.postMessage(
          { id: job.id, buffer: job.buffer, returnBuffer: job.returnBuffer },
          [job.buffer],
        );
      } catch (error) {
        this.handleWorkerFailure(slot, error);
      }
    }
  }

  private handleWorkerMessage(
    slot: WorkerSlot,
    response: HashWorkerResponse,
  ): void {
    const job = slot.job;
    if (!job) {
      return;
    }
    if (!response || response.id !== job.id) {
      this.handleWorkerFailure(slot, new Error("SHA-256 worker response ID mismatch."));
      return;
    }

    slot.job = null;
    if ("error" in response) {
      job.reject(workerResponseError(response.error));
    } else if (!(response.digest instanceof ArrayBuffer)) {
      job.reject(new Error("SHA-256 worker returned an invalid response."));
    } else if (job.returnBuffer && !(response.buffer instanceof ArrayBuffer)) {
      job.reject(new Error("SHA-256 worker did not return the input buffer."));
    } else {
      job.resolve({
        hash: digestToHex(response.digest),
        bytes:
          response.buffer instanceof ArrayBuffer
            ? new Uint8Array(response.buffer)
            : new Uint8Array(),
      });
    }
    this.pump();
  }

  private handleWorkerFailure(slot: WorkerSlot, error: unknown): void {
    const job = slot.job;
    slot.job = null;
    job?.reject(toError(error));

    this.detachAndTerminate(slot);
    if (this.disposedError) {
      return;
    }

    try {
      slot.worker = this.workerFactory();
      this.attachWorker(slot);
    } catch (creationError) {
      this.workerCreationError = toError(creationError);
      while (this.queuedJobs.length > 0) {
        this.queuedJobs.shift()?.reject(this.workerCreationError);
      }
      return;
    }

    this.pump();
  }

  private detachAndTerminate(slot: WorkerSlot): void {
    slot.worker.removeEventListener("message", slot.onMessage);
    slot.worker.removeEventListener("error", slot.onError);
    slot.worker.removeEventListener("messageerror", slot.onError);
    slot.worker.terminate();
  }

  private disposeWorkers(): void {
    for (const slot of this.slots) {
      this.detachAndTerminate(slot);
    }
  }

  private revokeWorkerSourceUrl(): void {
    if (this.workerSourceUrl && typeof URL !== "undefined") {
      URL.revokeObjectURL(this.workerSourceUrl);
    }
  }
}

export function createSha256ContentHasher(): SyncContentHasher {
  if (!canCreateDefaultWorker()) {
    return createDefaultContentHasher();
  }

  return new Sha256WorkerPool();
}

function createDefaultWorkerSetup(): {
  createWorker: () => Sha256WorkerLike;
  sourceUrl: string;
} {
  if (!canCreateDefaultWorker()) {
    throw new Error("Web Workers are not available for SHA-256 hashing.");
  }

  const sourceUrl = URL.createObjectURL(
    new Blob([SHA256_WORKER_SOURCE], { type: "application/javascript" }),
  );
  return {
    createWorker: () => new Worker(sourceUrl),
    sourceUrl,
  };
}

function canCreateDefaultWorker(): boolean {
  return (
    typeof Worker === "function" &&
    typeof Blob === "function" &&
    typeof URL !== "undefined" &&
    typeof URL.createObjectURL === "function"
  );
}

function normalizeConcurrency(value: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }

  return Math.max(1, Math.min(maximum, Math.floor(value)));
}

function copyBytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function transferableBytesBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.slice().buffer;
}

function digestToHex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function workerError(event: ErrorEvent | MessageEvent): Error {
  if (typeof ErrorEvent !== "undefined" && event instanceof ErrorEvent && event.error) {
    return toError(event.error);
  }

  const message = "message" in event && typeof event.message === "string"
    ? event.message
    : "SHA-256 worker failed.";
  return new Error(message);
}

function workerResponseError(error: unknown): Error {
  const record =
    typeof error === "object" && error !== null
      ? (error as { name?: unknown; message?: unknown })
      : null;
  const result = new Error(
    typeof record?.message === "string"
      ? record.message
      : "SHA-256 worker failed.",
  );
  if (typeof record?.name === "string" && record.name) {
    result.name = record.name;
  }
  return result;
}

function toError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error(typeof error === "string" ? error : "SHA-256 worker failed.");
}

const SHA256_WORKER_SOURCE = `
self.onmessage = async (event) => {
  const { id, buffer, returnBuffer } = event.data;
  try {
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    if (returnBuffer) {
      self.postMessage({ id, digest, buffer }, [digest, buffer]);
    } else {
      self.postMessage({ id, digest }, [digest]);
    }
  } catch (error) {
    self.postMessage({
      id,
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
};
`;
