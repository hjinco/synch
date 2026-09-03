import { describe, expect, it } from "vitest";

import { BytesInFlightBudget } from "./bytes-in-flight";
import { encodeUtf8 } from "./content";
import { createTestSyncStore } from "../../test-support/in-memory-sync-store";
import { SyncLocalReconcileService } from "../engine/local-reconcile-service";
import { SyncContentRuntime } from "./content-runtime";

describe("BytesInFlightBudget", () => {
  it("allows multiple smaller files without exceeding the budget", async () => {
    const budget = new BytesInFlightBudget(10);

    await budget.acquire(6);
    await budget.acquire(4);
    const queued = budget.acquire(1);
    await Promise.resolve();

    expect(budget.bytesInFlight).toBe(10);
    expect(budget.pendingReservations).toBe(1);

    budget.release(6);
    await queued;

    expect(budget.bytesInFlight).toBe(5);
    expect(budget.bytesInFlight).toBeLessThanOrEqual(10);
  });

  it("allows an oversized file only when it can run alone", async () => {
    const budget = new BytesInFlightBudget(10);

    await budget.acquire(4);
    const oversized = budget.acquire(11);
    await Promise.resolve();
    expect(budget.pendingReservations).toBe(1);

    budget.release(4);
    await oversized;

    expect(budget.bytesInFlight).toBe(11);
    const blockedWhileOversized = budget.acquire(1);
    await Promise.resolve();
    expect(budget.pendingReservations).toBe(1);

    budget.release(11);
    await blockedWhileOversized;
    expect(budget.bytesInFlight).toBe(1);
  });

  it("releases a reservation when work fails and wakes queued work", async () => {
    const budget = new BytesInFlightBudget(10);
    const failed = budget.withReservation(10, async () => {
      throw new Error("hash failed");
    });
    const queued = budget.withReservation(1, async () => "continued");

    await expect(failed).rejects.toThrow("hash failed");
    await expect(queued).resolves.toBe("continued");
    expect(budget.bytesInFlight).toBe(0);
  });

  it("reserves before reading and releases after a hash failure", async () => {
    const store = createTestSyncStore();
    const budget = new BytesInFlightBudget(4);
    let readStartedWithReservation = false;

    const service = new SyncLocalReconcileService({
      getSyncStore: () => store,
      getRemoteVaultKey: () => new Uint8Array(32),
      shouldSyncPath: () => true,
      scanner: {
        async listFiles() {
          return [
            {
              path: "note.md",
              mtime: 1,
              size: 4,
              async readBytes() {
                readStartedWithReservation = budget.bytesInFlight === 4;
                return encodeUtf8("body");
              },
            },
          ];
        },
      },
      contentRuntime: new SyncContentRuntime({
        byteBudget: budget,
        hasher: {
          async hash() {
            throw new Error("hash failed");
          },
          async hashAndReturnBytes() {
            throw new Error("hash failed");
          },
        },
      }),
    });

    await expect(service.reconcileOnce()).rejects.toThrow("hash failed");
    expect(readStartedWithReservation).toBe(true);
    expect(budget.bytesInFlight).toBe(0);
    await store.close();
  });
});
