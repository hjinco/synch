import { afterEach, describe, expect, it, vi } from "vitest";
import { PushMetrics } from "./push-metrics";

afterEach(() => vi.useRealTimers());

describe("push benchmark observations", () => {
  it("measures from run start, separates notes, and ignores replayed completions", () => {
    vi.useFakeTimers();
    let clock = 10_000;
    const metrics = new PushMetrics(() => clock, () => 1024);
    metrics.start();
    clock += 40;
    metrics.uploadStarted(100);
    metrics.commitStarted();
    metrics.committed();
    clock += 10;
    metrics.fileCompleted("note.md");
    clock += 50;
    metrics.slowUploadCompleted();
    clock += 20;
    metrics.committed();
    metrics.fileCompleted("attachment.bin");
    metrics.fileCompleted("note.md");
    clock += 10;
    metrics.stop();
    expect(metrics.snapshot()).toMatchObject({
      totalMs: 130,
      firstCommitMs: 40,
      firstNoteAppliedMs: 50,
      noteAppliedP95Ms: 50,
      fileAppliedP95Ms: 120,
      filesApplied: 2,
      notesAppliedBeforeSlowUpload: 1,
      slowUploadCompletedMs: 100,
      uploadRequests: 1,
      uploadedBytes: 100,
      commitRequests: 1,
    });
  });

  it("reports nearest-rank p95 across files rather than across commit batches", () => {
    vi.useFakeTimers();
    let clock = 0;
    const metrics = new PushMetrics(() => clock, () => 0);
    metrics.start();
    for (clock = 1; clock <= 20; clock += 1) metrics.fileCompleted(`${clock}.md`);
    metrics.stop();
    expect(metrics.snapshot().noteAppliedP95Ms).toBe(19);
  });

  it("samples process RSS only during the run and reports missing timings as null", () => {
    vi.useFakeTimers();
    let rss = 100;
    const metrics = new PushMetrics(() => performance.now(), () => rss);
    metrics.start();
    rss = 300;
    vi.advanceTimersByTime(20);
    rss = 150;
    metrics.stop();
    rss = 500;
    vi.advanceTimersByTime(100);
    expect(metrics.snapshot()).toMatchObject({
      initialRssBytes: 100,
      peakSampledRssBytes: 300,
      sampledRssIncreaseBytes: 200,
      firstCommitMs: null,
      firstNoteAppliedMs: null,
      fileAppliedP95Ms: null,
      notesAppliedBeforeSlowUpload: null,
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
