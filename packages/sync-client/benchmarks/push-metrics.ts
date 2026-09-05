/** Per-run observations. No file contents or identifiers are included in reports. */
export class PushMetrics {
  private startedAt = 0;
  private totalMs = 0;
  private firstCommitMs: number | null = null;
  private readonly completed = new Map<string, number>();
  private slowUploadCompletedMs: number | null = null;
  private uploadRequests = 0;
  private uploadedBytes = 0;
  private commitRequests = 0;
  private initialRssBytes = 0;
  private peakSampledRssBytes = 0;
  private sampler: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly rss: () => number = () => process.memoryUsage.rss(),
  ) {}

  start(): void {
    this.startedAt = this.now();
    this.initialRssBytes = this.rss();
    this.peakSampledRssBytes = this.initialRssBytes;
    this.sampler = setInterval(() => this.sampleMemory(), 20);
  }

  stop(): void {
    this.totalMs = this.elapsed();
    clearInterval(this.sampler);
    this.sampleMemory();
  }

  uploadStarted(bytes: number): void {
    this.uploadRequests += 1;
    this.uploadedBytes += bytes;
  }

  slowUploadCompleted(): void {
    this.slowUploadCompletedMs = this.elapsed();
  }

  commitStarted(): void {
    this.commitRequests += 1;
  }

  committed(): void {
    this.firstCommitMs ??= this.elapsed();
  }

  fileCompleted(path: string): void {
    // Count a file once even if an acknowledgement is replayed.
    if (!this.completed.has(path)) this.completed.set(path, this.elapsed());
  }

  snapshot() {
    const all = [...this.completed.values()];
    const notes = [...this.completed]
      .filter(([path]) => path.endsWith(".md"))
      .map(([, time]) => time);
    return {
      totalMs: this.totalMs,
      firstCommitMs: this.firstCommitMs,
      firstNoteAppliedMs: notes.length ? Math.min(...notes) : null,
      fileAppliedP95Ms: percentile95(all),
      noteAppliedP95Ms: percentile95(notes),
      filesApplied: all.length,
      notesAppliedBeforeSlowUpload: this.slowUploadCompletedMs === null
        ? null
        : notes.filter((time) => time < this.slowUploadCompletedMs!).length,
      slowUploadCompletedMs: this.slowUploadCompletedMs,
      uploadRequests: this.uploadRequests,
      uploadedBytes: this.uploadedBytes,
      commitRequests: this.commitRequests,
      initialRssBytes: this.initialRssBytes,
      peakSampledRssBytes: this.peakSampledRssBytes,
      sampledRssIncreaseBytes: this.peakSampledRssBytes - this.initialRssBytes,
    };
  }

  private elapsed(): number { return this.now() - this.startedAt; }
  private sampleMemory(): void {
    this.peakSampledRssBytes = Math.max(this.peakSampledRssBytes, this.rss());
  }
}

function percentile95(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}
