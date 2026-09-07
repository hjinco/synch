export interface TransferWindow {
  bytes: number;
  elapsedMs: number;
  meanDurationMs: number;
}

/** Pure controller; the scheduler supplies only sustained, busy observations. */
export class AdaptiveConcurrencyPolicy {
  // Short syncs often finish before the first observation. Start below the
  // preparation ceiling, with enough parallelism to hide request latency.
  private current = 8;
  private baseline: { rate: number; latency: number; limit: number } | undefined;
  private probing = false;
  private nextProbeAt = 0;
  private nextDecreaseAt = 0;
  private steady: { rate: number; latency: number } | undefined;
  private degradedWindows = 0;

  constructor(private readonly maximum = 12) {
    if (!Number.isInteger(maximum) || maximum < 1) {
      throw new Error("Transfer concurrency maximum must be a positive integer.");
    }
    this.current = Math.min(this.current, maximum);
  }

  get limit(): number { return this.current; }

  observe(window: TransferWindow, now: number): void {
    if (window.bytes <= 0 || window.elapsedMs <= 0) return;
    const rate = window.bytes / window.elapsedMs;
    if (this.probing && this.baseline) {
      // Keep the extra slot only when aggregate throughput improves materially.
      const improved = rate >= this.baseline.rate * 1.1
        && window.meanDurationMs <= this.baseline.latency * 2;
      if (!improved) {
        this.current = this.baseline.limit;
      }
      this.probing = false;
      this.baseline = undefined;
      this.steady = undefined;
      // Cool down after saturation, but keep exploring when capacity is growing.
      this.nextProbeAt = improved ? now : now + 10_000;
      return;
    }
    if (this.steady && rate < this.steady.rate * 0.7
      && window.meanDurationMs > this.steady.latency * 1.5) {
      this.degradedWindows += 1;
      if (this.degradedWindows >= 2) this.congested(now);
      return;
    }
    this.degradedWindows = 0;
    this.steady = { rate, latency: window.meanDurationMs };
    if (now < this.nextProbeAt || this.current >= this.maximum) return;
    this.baseline = { rate, latency: window.meanDurationMs, limit: this.current };
    this.current += 1;
    this.probing = true;
  }

  congested(now: number): void {
    // A burst of failures from one group of requests causes one reduction.
    if (now < this.nextDecreaseAt) return;
    this.current = Math.max(1, Math.floor(this.current / 2));
    this.baseline = undefined;
    this.probing = false;
    this.steady = undefined;
    this.degradedWindows = 0;
    this.nextDecreaseAt = now + 5_000;
    this.nextProbeAt = now + 10_000;
  }

  idle(): void {
    // An interrupted experiment cannot be compared against a later workload.
    if (this.probing && this.baseline) this.current = this.baseline.limit;
    this.baseline = undefined;
    this.probing = false;
    this.steady = undefined;
    this.degradedWindows = 0;
  }
}
