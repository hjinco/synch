export const MAX_BYTES_IN_FLIGHT = 512 * 1024 * 1024;

export interface BytesInFlightBudgetLike {
  acquire(bytes: number): Promise<void>;
  release(bytes: number): void;
  withReservation<T>(bytes: number, work: () => Promise<T>): Promise<T>;
  dispose?(reason?: unknown): void;
}

interface WaitingReservation {
  bytes: number;
  resolve: () => void;
  reject: (reason?: unknown) => void;
}

/**
 * Limits the total size of file buffers that are between read and hash
 * completion. Files larger than the normal budget are admitted exclusively
 * when no other reservation is active.
 */
export class BytesInFlightBudget implements BytesInFlightBudgetLike {
  private reservedBytes = 0;
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

  async acquire(bytes: number): Promise<void> {
    const normalizedBytes = validateByteCount(bytes);
    if (this.disposedError) {
      throw this.disposedError;
    }

    if (this.canAcquire(normalizedBytes)) {
      this.reserve(normalizedBytes);
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.waiting.push({
        bytes: normalizedBytes,
        resolve,
        reject,
      });
      this.drain();
    });
  }

  release(bytes: number): void {
    const normalizedBytes = validateByteCount(bytes);
    this.reservedBytes -= normalizedBytes;
    if (this.reservedBytes < 0) {
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
      return this.reservedBytes === 0;
    }

    return this.reservedBytes + bytes <= this.maxBytes;
  }

  private reserve(bytes: number): void {
    this.reservedBytes += bytes;
  }

  private drain(): void {
    if (this.disposedError) {
      return;
    }

    // TODO: Add an admission barrier or another fairness policy once an
    // oversized reservation is waiting. Otherwise a sustained stream of
    // smaller reservations can keep reservedBytes above zero indefinitely
    // and prevent the oversized file from ever receiving exclusive access.
    // Grant the first request that fits. This lets small files keep making
    // progress while an oversized file waits for exclusive access.
    while (this.waiting.length > 0) {
      const index = this.waiting.findIndex(({ bytes }) => this.canAcquire(bytes));
      if (index < 0) {
        return;
      }

      const reservation = this.waiting.splice(index, 1)[0];
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
