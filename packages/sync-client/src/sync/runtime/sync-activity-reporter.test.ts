import { describe, expect, it, vi } from "vitest";

import { SyncActivityReporter } from "./sync-activity-reporter";
import type { SyncOperationProgress } from "./user-visible-status";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const baseline = { completedEntries: 1, totalEntries: 1 };
const pullProgress: SyncOperationProgress = {
  direction: "pull", totalKnown: true, completedEntries: 1, totalEntries: 3,
};
const pushProgress: SyncOperationProgress = {
  direction: "push", totalKnown: true, completedEntries: 2, totalEntries: 4,
};

function createReporter() {
  const setProgress = vi.fn();
  const getBaselineProgress = vi.fn(async () => baseline);
  const reporter = new SyncActivityReporter({ setProgress, getBaselineProgress });
  return { reporter, setProgress, getBaselineProgress };
}

describe("SyncActivityReporter", () => {
  it("hands progress to the next remote operation and ignores completed reporters", async () => {
    const { reporter, setProgress } = createReporter();
    const finishPull = deferred();
    const finishPush = deferred();
    let lateReport = async (_progress: SyncOperationProgress) => {};
    const pull = reporter.run("pull", async (report) => {
      lateReport = report;
      await report(pullProgress);
      await finishPull.promise;
    });
    const push = reporter.run("push", async (report) => {
      await report(pushProgress);
      await finishPush.promise;
    });

    expect(setProgress.mock.calls).toEqual([[pullProgress]]);
    finishPull.resolve();
    await pull;
    expect(setProgress.mock.calls).toEqual([[pullProgress], [pushProgress]]);
    await lateReport({ ...pullProgress, completedEntries: 3 });
    expect(setProgress).toHaveBeenCalledTimes(2);
    finishPush.resolve();
    await push;
    expect(setProgress).toHaveBeenLastCalledWith(baseline);
  });

  it("keeps baseline refreshes from overwriting an active pull", async () => {
    const { reporter, setProgress } = createReporter();
    const updated = { ...pullProgress, completedEntries: 2 };
    await reporter.run("pull", async (report) => {
      await report(pullProgress);
      await reporter.refreshBaseline();
      await report(updated);
    });

    expect(setProgress.mock.calls).toEqual([[pullProgress], [updated], [baseline]]);
  });

  it("keeps remote progress visible when overlapping local work finishes first", async () => {
    const { reporter, setProgress } = createReporter();
    const finishLocal = deferred();
    const finishPull = deferred();
    const local = reporter.run("local", async () => { await finishLocal.promise; });
    const pull = reporter.run("pull", async (report) => {
      await report(pullProgress);
      await finishPull.promise;
    });

    finishLocal.resolve();
    await local;
    await reporter.refreshBaseline();
    expect(setProgress.mock.calls).toEqual([[pullProgress]]);
    finishPull.resolve();
    await pull;
    expect(setProgress.mock.calls).toEqual([[pullProgress], [baseline]]);
  });

  it("does not publish a baseline read that completes during new work", async () => {
    const { reporter, setProgress, getBaselineProgress } = createReporter();
    const baselineReady = deferred();
    const finishPull = deferred();
    getBaselineProgress.mockImplementationOnce(async () => {
      await baselineReady.promise;
      return baseline;
    });
    const refresh = reporter.refreshBaseline();
    const pull = reporter.run("pull", async (report) => {
      await report(pullProgress);
      await finishPull.promise;
    });
    baselineReady.resolve();
    await refresh;
    expect(setProgress.mock.calls).toEqual([[pullProgress]]);
    finishPull.resolve();
    await pull;
  });

  it("releases failed activity and preserves the work error", async () => {
    const { reporter, setProgress } = createReporter();
    const error = new Error("pull failed");
    await expect(reporter.run("pull", async (report) => {
      await report(pullProgress);
      throw error;
    })).rejects.toBe(error);
    expect(setProgress.mock.calls).toEqual([[pullProgress], [baseline]]);
  });
});
