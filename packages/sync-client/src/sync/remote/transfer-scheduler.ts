import { AdaptiveConcurrencyPolicy } from "./adaptive-concurrency-policy";

export type TransferDirection = "upload" | "download";
export interface TransferResult<T> { value: T; bytes: number }
interface Lane {
  policy: AdaptiveConcurrencyPolicy;
  queue: Array<() => void>;
  active: number;
  pausedAt?: number;
  window?: {
    busySince?: number;
    elapsedMs: number;
    bytes: number;
    count: number;
    duration: number;
  };
}

const OBSERVATION_EXPIRY_MS = 10_000;

/** Engine-scoped admission control. Retries remain owned by the sync engine. */
export class TransferScheduler {
  private readonly lanes: Record<TransferDirection, Lane>;
  private closed = false;
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly now: () => number = () => performance.now()) {
    const lane = (): Lane => ({ policy: new AdaptiveConcurrencyPolicy(), queue: [], active: 0 });
    this.lanes = { upload: lane(), download: lane() };
  }

  run<T>(direction: TransferDirection, work: () => Promise<TransferResult<T>>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Transfer scheduler is closed."));
    const lane = this.lanes[direction];
    const promise = new Promise<T>((resolve, reject) => {
      lane.queue.push(() => {
        if (this.closed) {
          reject(new Error("Transfer scheduler is closed."));
          return;
        }
        lane.active += 1;
        const start = this.now();
        void Promise.resolve().then(work).then(result => {
          if (lane.window?.busySince !== undefined) {
            lane.window.bytes += result.bytes;
            lane.window.count += 1;
            lane.window.duration += this.now() - start;
          }
          resolve(result.value);
        }, error => {
          if (isCongestionError(error)) lane.policy.congested(this.now());
          else lane.policy.idle();
          lane.window = undefined;
          reject(error);
        }).finally(() => {
          lane.active -= 1;
          this.pump(lane);
        });
      });
      this.pump(lane);
    });
    this.pending.add(promise);
    void promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
    return promise;
  }

  async dispose(): Promise<void> {
    this.closed = true;
    for (const lane of Object.values(this.lanes)) {
      for (const start of lane.queue.splice(0)) start();
    }
    await Promise.allSettled([...this.pending]);
  }

  private pump(lane: Lane): void {
    const now = this.now();
    // Brief preparation/apply gaps belong to the same workload. A long gap
    // invalidates both accumulated samples and any unfinished concurrency probe.
    if (lane.pausedAt !== undefined && now - lane.pausedAt >= OBSERVATION_EXPIRY_MS) {
      lane.window = undefined;
      lane.policy.idle();
      lane.pausedAt = undefined;
    }
    const window = lane.window;
    if (window?.busySince !== undefined) {
      window.elapsedMs += now - window.busySince;
      window.busySince = now;
    }
    if (window && window.elapsedMs >= 2_000 && window.count >= 4) {
      lane.policy.observe({
        bytes: window.bytes,
        elapsedMs: window.elapsedMs,
        meanDurationMs: window.duration / window.count,
      }, now);
      lane.window = undefined;
    }
    while (!this.closed && lane.active < lane.policy.limit && lane.queue.length > 0) {
      lane.queue.shift()!();
    }
    if (lane.queue.length > 0 && lane.active >= lane.policy.limit) {
      lane.pausedAt = undefined;
      lane.window ??= { elapsedMs: 0, bytes: 0, count: 0, duration: 0 };
      lane.window.busySince = now;
    } else {
      // Pause the busy clock and ignore tail completions until demand resumes.
      // Keeping the partial window lets short batches eventually yield a sample.
      if (lane.window) lane.window.busySince = undefined;
      lane.pausedAt ??= now;
    }
  }
}

function isCongestionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { status?: unknown; name?: unknown; code?: unknown };
  return [408, 429, 502, 503, 504].includes(value.status as number)
    || value.name === "TimeoutError"
    || value.code === "ETIMEDOUT"
    || value.code === "ESOCKETTIMEDOUT";
}
