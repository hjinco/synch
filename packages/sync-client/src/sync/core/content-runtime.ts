import {
  type HashedBytes,
  type SyncContentHasher,
} from "./content";
import {
  BytesInFlightBudget,
  type BytesInFlightBudgetLike,
} from "./bytes-in-flight";
import { createSha256ContentHasher as createDefaultSha256ContentHasher } from "./sha256-worker-pool";

export interface SyncContentRuntimeDeps {
  /** Shared runtime borrowed from the engine or a standalone service's caller. */
  contentRuntime: SyncContentRuntime;
}

export interface SyncContentRuntimeOptions {
  hasher?: SyncContentHasher;
  byteBudget?: BytesInFlightBudgetLike;
}

/**
 * The single entry point for content reads and hashing within a sync engine.
 * It keeps the CPU worker pool and the byte budget separate internally while
 * making the read/hash reservation boundary consistent for all callers.
 */
export class SyncContentRuntime {
  private readonly hasher: SyncContentHasher;
  private readonly byteBudget: BytesInFlightBudgetLike;
  private readonly ownsHasher: boolean;
  private readonly ownsByteBudget: boolean;
  private disposed = false;

  constructor(options: SyncContentRuntimeOptions = {}) {
    this.ownsHasher = !options.hasher;
    this.ownsByteBudget = !options.byteBudget;
    this.hasher = options.hasher ?? createDefaultSha256ContentHasher();
    this.byteBudget = options.byteBudget ?? new BytesInFlightBudget();
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
  ): Promise<HashedBytes> {
    return await this.byteBudget.withReservation(size, async () => {
      return await this.hashAndReturnBytes(await readBytes());
    });
  }

  async withReadBytes<T>(
    size: number,
    readBytes: () => Promise<Uint8Array>,
    work: (bytes: Uint8Array) => Promise<T>,
  ): Promise<T> {
    return await this.byteBudget.withReservation(size, async () => {
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
    if (this.ownsHasher) {
      await this.hasher.dispose?.();
    }
  }
}
