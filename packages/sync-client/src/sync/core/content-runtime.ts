import {
  type HashedBytes,
  type SyncContentHasher,
} from "./content";
import {
  BytesInFlightBudget,
  type BytesInFlightBudgetLike,
} from "./bytes-in-flight";
import { createSha256ContentHasher as createDefaultSha256ContentHasher } from "./sha256-worker-pool";

export interface ContentReservation {
  release(): void;
  /** Charge another group input against the estimate, growing without waiting. */
  retain(bytes: number): void;
}

/** Optional cached content can be discarded to admit active work. */
export interface IdleContent {
  reclaim(): Promise<void>;
  dispose(): Promise<void>;
}

export interface SyncContentRuntimeDeps {
  /** Shared runtime borrowed from the engine or a standalone service's caller. */
  contentRuntime: SyncContentRuntime;
}

export interface SyncContentRuntimeOptions {
  hasher?: SyncContentHasher;
  byteBudget?: BytesInFlightBudgetLike;
  maxBytesInFlight?: number;
}

/**
 * Shared hashing and source-byte admission for a sync engine.
 * It keeps the CPU worker pool and the byte budget separate internally while
 * allowing a file reservation to outlive preparation until its final consumer.
 */
export class SyncContentRuntime {
  private readonly hasher: SyncContentHasher;
  private readonly byteBudget: BytesInFlightBudgetLike;
  private readonly ownsHasher: boolean;
  private readonly ownsByteBudget: boolean;
  private disposed = false;
  private readonly reclaimable = new Set<IdleContent>();
  private reclaiming: Promise<void> | undefined;

  constructor(options: SyncContentRuntimeOptions = {}) {
    this.ownsHasher = !options.hasher;
    this.ownsByteBudget = !options.byteBudget;
    this.hasher = options.hasher ?? createDefaultSha256ContentHasher();
    this.byteBudget = options.byteBudget ?? new BytesInFlightBudget(options.maxBytesInFlight);
  }

  /** Reserves caller-estimated bytes; this is not a process heap measurement. */
  async reserve(size: number): Promise<ContentReservation> {
    const admitted = this.byteBudget.acquire(size);
    this.reclaimIdleContent();
    await admitted;
    return this.ownReservation(size);
  }

  /** Optional caches must never wait while holding an input. */
  tryReserve(size: number): ContentReservation | null {
    return this.byteBudget.tryAcquire(size) ? this.ownReservation(size) : null;
  }

  registerIdleContent(content: IdleContent): void {
    this.reclaimable.add(content);
    this.reclaimIdleContent();
  }

  unregisterIdleContent(content: IdleContent): void {
    this.reclaimable.delete(content);
  }

  private ownReservation(size: number): ContentReservation {
    let released = false;
    let retained = 0;
    return {
      retain: (bytes) => {
        if (released) throw new Error("Content reservation was released.");
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid retained byte count.");
        retained += bytes;
        if (retained > size) {
          this.byteBudget.resizeReservation(size, retained);
          size = retained;
        }
      },
      release: () => {
        if (released) return;
        released = true;
        this.byteBudget.release(size);
      },
    };
  }

  private reclaimIdleContent(): void {
    if (this.reclaiming || this.disposed || this.byteBudget.pendingReservations === 0) return;
    this.reclaiming = (async () => {
      while (this.byteBudget.pendingReservations > 0) {
        const next = this.reclaimable.values().next().value;
        if (!next) break;
        this.reclaimable.delete(next);
        // Discard optional cache entries and return their reservations.
        await next.reclaim();
      }
    })().finally(() => {
      this.reclaiming = undefined;
      if (this.reclaimable.size > 0 && this.byteBudget.pendingReservations > 0) {
        this.reclaimIdleContent();
      }
    });
  }

  async withReservation<T>(size: number, work: () => Promise<T>): Promise<T> {
    const reservation = await this.reserve(size);
    try {
      return await work();
    } finally {
      reservation.release();
    }
  }

  async hash(bytes: Uint8Array): Promise<string> {
    return await this.hasher.hash(bytes);
  }

  async hashAndReturnBytes(bytes: Uint8Array): Promise<HashedBytes> {
    return await this.hasher.hashAndReturnBytes(bytes);
  }

  async readAndHash(
    size: number,
    readBytes: () => Promise<Uint8Array>,
    reservation?: ContentReservation,
  ): Promise<HashedBytes> {
    return await this.withReadBytes(size, readBytes, async (bytes) =>
      await this.hashAndReturnBytes(bytes), reservation);
  }

  async withReadBytes<T>(
    size: number,
    readBytes: () => Promise<Uint8Array>,
    work: (bytes: Uint8Array) => Promise<T>,
    reservation?: ContentReservation,
  ): Promise<T> {
    if (reservation) {
      // Local conflict/merge input and UTF-16/intermediate working space. This
      // is an estimate, not a bound on the merge algorithm or process heap.
      reservation.retain(size * 8);
      const bytes = await readBytes();
      if (bytes.byteLength > size) reservation.retain((bytes.byteLength - size) * 8);
      return await work(bytes);
    }
    return await this.withReservation(size, async () => {
      return await work(await readBytes());
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    if (this.ownsByteBudget) {
      this.byteBudget.dispose?.();
    }
    await this.reclaiming;
    await Promise.all([...this.reclaimable].map((entry) => entry.dispose()));
    if (this.ownsHasher) {
      await this.hasher.dispose?.();
    }
  }
}
