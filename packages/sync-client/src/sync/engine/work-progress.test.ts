import { describe, expect, it } from "vitest";
import { SyncWorkProgress } from "./work-progress";
import { getUserVisibleSyncPercent } from "../runtime/user-visible-status";

describe("SyncWorkProgress", () => {
  it("counts registered revisions once across retries and seals the denominator", () => {
    const progress = new SyncWorkProgress("pull");
    progress.register(["a:1", "b:1"]);
    progress.complete(["a:1", "a:1"]);
    expect(getUserVisibleSyncPercent(progress.snapshot())).toBeNull();
    progress.register(["a:1", "a:2"]);
    progress.seal();
    progress.complete(["a:2"]);
    expect(progress.snapshot()).toEqual({ direction: "pull", totalKnown: true, completedEntries: 2, totalEntries: 3 });
    expect(() => progress.register(["c:1"])).toThrow();
    expect(() => progress.complete(["c:1"])).toThrow();
    progress.complete(["b:1"]);
    expect(getUserVisibleSyncPercent(progress.snapshot())).toBe(100);
  });

  it("does not count registered but failed mutations as completed", () => {
    const progress = new SyncWorkProgress("push");
    progress.register(["accepted", "blocked", "requeued"]);
    progress.complete(["accepted"]);
    progress.seal();
    expect(progress.snapshot().completedEntries).toBe(1);
    expect(progress.snapshot().totalEntries).toBe(3);
  });
});
