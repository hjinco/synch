export interface BandwidthStep { afterMs: number; bytesPerSecond: number }

/** Application-level fair sharing model, not TCP or kernel traffic shaping.
 * Each tick spends one aggregate budget across all pending bodies. Idle time
 * earns no credit, and a large attachment cannot reserve future capacity.
 */
export class SharedBandwidth {
  private readonly pending: Array<{ remaining: number; resolve: () => void }> = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly started: number;
  private last: number;

  constructor(private readonly steps: readonly BandwidthStep[], private readonly now = () => performance.now()) {
    if (!steps.length || steps[0].afterMs !== 0 || steps.some((step, i) =>
      !Number.isFinite(step.bytesPerSecond) || step.bytesPerSecond <= 0
      || !Number.isFinite(step.afterMs) || step.afterMs < 0
      || (i > 0 && step.afterMs <= steps[i - 1].afterMs))) throw new Error("Invalid bandwidth schedule");
    this.started = this.last = now();
  }

  transfer(bytes: number): Promise<void> {
    if (!Number.isFinite(bytes) || bytes < 0) throw new Error("Invalid transfer size");
    if (!bytes) return Promise.resolve();
    // Account for existing transfers before admitting a new participant.
    this.advance();
    return new Promise(resolve => {
      this.pending.push({ remaining: bytes, resolve });
      this.schedule();
    });
  }

  private advance() {
    const now = this.now();
    let budget = 0;
    for (let i = 0; i < this.steps.length; i++) {
      const from = Math.max(this.last, this.started + this.steps[i].afterMs);
      const to = Math.min(now, this.started + (this.steps[i + 1]?.afterMs ?? Infinity));
      budget += Math.max(0, to - from) * this.steps[i].bytesPerSecond / 1000;
    }
    this.last = now;
    while (budget > 0 && this.pending.length) {
      const share = Math.min(budget / this.pending.length, ...this.pending.map(job => job.remaining));
      budget -= share * this.pending.length;
      for (const job of this.pending) job.remaining -= share;
      for (let i = this.pending.length - 1; i >= 0; i--) {
        if (this.pending[i].remaining <= 1e-7) this.pending.splice(i, 1)[0].resolve();
      }
    }
  }

  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.advance();
      if (this.pending.length) this.schedule();
    }, 10);
  }
}
