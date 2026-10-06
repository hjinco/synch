import { describe, expect, it } from "vitest";
import { SyncStateChangedError, SyncStateCoordinator } from "../sync-state-coordinator";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("sync state coordination", () => {
  it("orders overlapping rename keys, admits unrelated work, and releases failed work", async () => {
    const coordinator = new SyncStateCoordinator();
    const started = gate();
    const release = gate();
    const order: string[] = [];
    const first = coordinator.run(["entry:a", "path:old", "path:new"], async () => {
      started.resolve();
      await release.promise;
      order.push("first");
      throw new Error("write failed");
    });
    const failed = expect(first).rejects.toThrow("write failed");
    await started.promise;
    const second = coordinator.run(["path:new", "path:old", "entry:b"], async () => { order.push("second"); });
    const third = coordinator.run(["entry:b"], async () => { order.push("third"); });
    await coordinator.run(["path:unrelated"], async () => { order.push("unrelated"); });
    expect(order).toEqual(["unrelated"]);
    release.resolve();
    await Promise.all([failed, second, third]);
    expect(order).toEqual(["unrelated", "first", "second", "third"]);
  });

  it("invalidates prepared work only when its resources changed, including active work", async () => {
    const coordinator = new SyncStateCoordinator();
    const before = coordinator.watch();
    const started = gate();
    const release = gate();
    const writing = coordinator.run(["entry:a", "path:a"], async () => {
      started.resolve();
      await release.promise;
    });
    await started.promise;
    const during = coordinator.watch();
    release.resolve();
    await writing;
    for (const [index, snapshot] of [before, during].entries()) {
      await expect(coordinator.run(["path:a"], async () => {}, [snapshot])).rejects.toBeInstanceOf(SyncStateChangedError);
      await coordinator.run([`path:b${index}`], async () => {}, [snapshot]);
      snapshot.dispose();
    }
    await coordinator.run(["path:a"], async () => {});
  });
});
