import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncMetrics } from "./metrics";

afterEach(() => vi.useRealTimers());

describe("push benchmark observations", () => {
  it("measures from run start, separates notes, and ignores replayed completions", () => {
    vi.useFakeTimers();
    let clock = 10_000;
    const metrics = new SyncMetrics(() => clock, () => 1024);
    metrics.start();
    clock += 40;
    metrics.uploadStarted(100);
    metrics.commitStarted();
    metrics.commitAcknowledged();
    clock += 10;
    metrics.fileCompleted("note.md");
    clock += 50;
    metrics.attachmentUploadCompleted();
    clock += 20;
    metrics.commitAcknowledged();
    metrics.fileCompleted("attachment.bin");
    metrics.fileCompleted("note.md");
    clock += 10;
    metrics.stop();
    expect(metrics.snapshot()).toMatchObject({
      totalMs: 130,
      firstCommitAckMs: 40,
      firstNoteAppliedMs: 50,
      noteAppliedP95Ms: 50,
      fileAppliedP95Ms: 120,
      filesApplied: 2,
      notesAppliedBeforeAttachmentUploadCompleted: 1,
      uploadCompletedMs: 100,
      uploadRequests: 1,
      uploadedBytes: 100,
      commitRequests: 1,
    });
  });

  it("reports nearest-rank p95 across files rather than across commit batches", () => {
    vi.useFakeTimers();
    let clock = 0;
    const metrics = new SyncMetrics(() => clock, () => 0);
    metrics.start();
    for (clock = 1; clock <= 20; clock += 1) metrics.fileCompleted(`${clock}.md`);
    metrics.stop();
    expect(metrics.snapshot().noteAppliedP95Ms).toBe(19);
  });

  it("samples process RSS only during the run and reports missing timings as null", () => {
    vi.useFakeTimers();
    let rss = 100;
    const metrics = new SyncMetrics(() => performance.now(), () => rss);
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
      firstCommitAckMs: null,
      firstNoteAppliedMs: null,
      fileAppliedP95Ms: null,
      notesAppliedBeforeAttachmentUploadCompleted: null,
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
