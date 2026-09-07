export const MAX_BYTES_IN_FLIGHT = 512 * 1024 * 1024;

export interface BytesInFlightBudgetLike {
  readonly pendingReservations: number;
  tryAcquire(bytes: number): boolean;
  acquire(bytes: number): Promise<void>;
  release(bytes: number): void;
  resizeReservation(previous: number, next: number): void;
  withReservation<T>(bytes: number, work: () => Promise<T>): Promise<T>;
  dispose?(reason?: unknown): void;
}

interface WaitingReservation {
  bytes: number;
  resolve: () => void;
  reject: (reason?: unknown) => void;
}

/**
 * Limits source bytes held by active sync operations. Files larger than the
 * normal budget are admitted exclusively when no other reservation is active.
 */
export class BytesInFlightBudget implements BytesInFlightBudgetLike {
  private reservedBytes = 0;
  private activeReservations = 0;
  private readonly waiting: WaitingReservation[] = [];
  private disposedError: Error | null = null;

  constructor(private readonly maxBytes = MAX_BYTES_IN_FLIGHT) {
    validateByteCount(maxBytes);
  }

  get bytesInFlight(): number {
    return this.reservedBytes;
  }

  get pendingReservations(): number {
    return this.waiting.length;
  }

  tryAcquire(bytes: number): boolean {
    const normalizedBytes = validateByteCount(bytes);
    if (this.disposedError) throw this.disposedError;
    if (this.waiting.length > 0 || !this.canAcquire(normalizedBytes)) return false;
    this.reserve(normalizedBytes);
    return true;
  }

  async acquire(bytes: number): Promise<void> {
    const normalizedBytes = validateByteCount(bytes);
    if (this.tryAcquire(normalizedBytes)) return;

    await new Promise<void>((resolve, reject) => {
      this.waiting.push({
        bytes: normalizedBytes,
        resolve,
        reject,
      });
      this.drain();
    });
  }

  /** Account for already admitted work without waiting while it holds buffers.
   * Unknown sizes and growing local files may exceed the budget; new admission
   * remains blocked until their owner releases the reservation.
   */
  resizeReservation(previous: number, next: number): void {
    this.reservedBytes += validateByteCount(next) - validateByteCount(previous);
    this.drain();
  }

  release(bytes: number): void {
    const normalizedBytes = validateByteCount(bytes);
    this.activeReservations -= 1;
    this.reservedBytes -= normalizedBytes;
    if (this.reservedBytes < 0 || this.activeReservations < 0) {
      throw new Error("Released more bytes than were reserved.");
    }
    this.drain();
  }

  async withReservation<T>(bytes: number, work: () => Promise<T>): Promise<T> {
    await this.acquire(bytes);
    try {
      return await work();
    } finally {
      this.release(bytes);
    }
  }

  dispose(reason: unknown = new Error("Bytes-in-flight budget was disposed.")): void {
    if (this.disposedError) {
      return;
    }

    this.disposedError = toError(reason);
    while (this.waiting.length > 0) {
      this.waiting.shift()?.reject(this.disposedError);
    }
  }

  private canAcquire(bytes: number): boolean {
    if (bytes > this.maxBytes) {
      return this.activeReservations === 0;
    }

    return this.reservedBytes + bytes <= this.maxBytes;
  }

  private reserve(bytes: number): void {
    this.activeReservations += 1;
    this.reservedBytes += bytes;
  }

  private drain(): void {
    if (this.disposedError) {
      return;
    }

    // FIFO admission prevents a stream of small files starving an oversized file.
    while (this.waiting.length > 0) {
      if (!this.canAcquire(this.waiting[0]!.bytes)) return;
      const reservation = this.waiting.shift();
      if (!reservation) {
        return;
      }

      this.reserve(reservation.bytes);
      reservation.resolve();
    }
  }
}

function validateByteCount(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new TypeError("Byte reservations must be finite and non-negative.");
  }

  return Math.floor(bytes);
}

function toError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }

  return new Error(
    typeof reason === "string" ? reason : "Bytes-in-flight budget was disposed.",
  );
}
