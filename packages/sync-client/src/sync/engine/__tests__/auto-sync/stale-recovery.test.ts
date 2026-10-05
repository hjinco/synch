import { describe, expect, it, vi } from "vitest";
import { createTestSyncStore } from "../../../../test-support/in-memory-sync-store";
import { SyncAutoLoop } from "../../auto-sync";
import { RecoveryPendingDependenciesError } from "../../pull-recovery-manifest";
import type { PushPendingMutationsOptions } from "../../push-service";
import type { SyncRealtimeSession } from "../../../remote/realtime-client";
import { createPushResult, createRealtimeClient, createToken } from "./helpers";

async function setup(recover: "resolve" | "unchanged" | "fail", resolveInDelta = false) {
  vi.useFakeTimers();
  const store = createTestSyncStore();
  const mutation = {
    entryId: "note", mutationId: "local-edit", baseRevision: 3,
    op: "upsert" as const, blobId: "local-blob", hash: "local-hash",
    encryptedMetadata: "encrypted", createdAt: 1,
  };
  await store.markEntryDirty(mutation);
  await store.setCursor(100);
  const onRetryScheduled = vi.fn();
  const onError = vi.fn();
  const onIdle = vi.fn();
  const pullOnce = vi.fn(async () => {
    if (resolveInDelta) await store.clearDirtyEntryByMutationId(mutation.mutationId);
  });
  const recoverEntryStates = vi.fn(async () => {
    if (recover === "fail") throw new Error("recovery offline");
    if (recover === "resolve") await store.clearDirtyEntryByMutationId(mutation.mutationId);
  });
  const pushPendingMutations = vi.fn(async (
    _session: SyncRealtimeSession,
    _shouldYield: () => boolean,
    _options?: PushPendingMutationsOptions,
  ) => {
    // Bound a regression without hanging the test process on an infinite loop.
    if (pushPendingMutations.mock.calls.length > 10) loop.stop();
    return (await store.getDirtyEntryMutation(mutation.entryId))
      ? createPushResult({
          cursor: 100, mutationsPushed: 0, mutationsRequeued: 1,
          filesCreatedOrUpdated: 0, shouldPullAfterPush: true, hasMore: true,
          staleMutations: [{ entryId: mutation.entryId, baseRevision: 3 }],
        })
      : createPushResult({ hasMore: false });
  });
  const loop = new SyncAutoLoop({
    getApiBaseUrl: () => "http://localhost", getSyncToken: async () => createToken(),
    getSyncStore: () => store, realtimeClient: createRealtimeClient(undefined, undefined, 100),
    pullOnce, recoverEntryStates, pushPendingMutations, onRetryScheduled, onError, onIdle,
    syncRetryBaseDelayMs: 1_000, syncRetryMaxDelayMs: 4_000,
  });
  await loop.start();
  onIdle.mockClear();
  loop.notifyLocalChange();
  loop.flushDebouncedPush();
  await loop.waitForInFlightDrain();
  return { loop, store, mutation, pushPendingMutations, pullOnce, recoverEntryStates, onRetryScheduled, onError, onIdle };
}

describe("stale revision recovery", () => {
  it("prioritizes recovery dependencies on retry and preserves backoff until they resolve", async () => {
    const test = await setup("unchanged");
    const dependency = { ...test.mutation, entryId: "owner", mutationId: "owner-edit" };
    await test.store.markEntryDirty(dependency);
    test.recoverEntryStates.mockRejectedValue(new RecoveryPendingDependenciesError(["owner"]));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(test.onRetryScheduled).toHaveBeenLastCalledWith({ attempt: 2, delayMs: 2_000 });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(test.pushPendingMutations).toHaveBeenLastCalledWith(
      expect.anything(), expect.any(Function), { priorityEntryIds: ["owner"] },
    );
    expect(test.onRetryScheduled).toHaveBeenLastCalledWith({ attempt: 3, delayMs: 4_000 });
    expect(await test.store.getDirtyEntryMutation("owner")).toEqual(dependency);

    test.pushPendingMutations.mockImplementation(async (_session, _yield, options) => {
      expect(options?.priorityEntryIds).toEqual(["owner"]);
      await test.store.clearDirtyEntryByMutationId(dependency.mutationId);
      return createPushResult({ hasMore: true, shouldPullAfterPush: true,
        staleMutations: [{ entryId: "note", baseRevision: 3 }],
      });
    });
    test.recoverEntryStates.mockImplementation(async () => {
      await test.store.clearDirtyEntryByMutationId(test.mutation.mutationId);
      test.pushPendingMutations.mockResolvedValue(createPushResult({ hasMore: false }));
    });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await test.store.listDirtyEntries()).toEqual([]);
    expect(test.onIdle).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    test.loop.stop();
    await test.store.close();
  });

  it("recovers an unchanged pending mutation after an empty delta and drains normally", async () => {
    const test = await setup("resolve");
    expect(test.recoverEntryStates).toHaveBeenCalledWith(expect.anything(), ["note"]);
    expect(test.pushPendingMutations).toHaveBeenCalledTimes(2);
    expect(test.onRetryScheduled).not.toHaveBeenCalled();
    expect(test.onIdle).toHaveBeenCalledTimes(1);
    expect(await test.store.getCursor()).toBe(100);
    test.loop.stop();
    await test.store.close();
  });

  it("does not request recovery when the ordinary pull resolved the conflict", async () => {
    const test = await setup("unchanged", true);
    expect(test.recoverEntryStates).not.toHaveBeenCalled();
    expect(test.onError).not.toHaveBeenCalled();
    expect(test.onIdle).toHaveBeenCalledTimes(1);
    test.loop.stop();
    await test.store.close();
  });

  it.each(["unchanged", "fail"] as const)("preserves pending changes and backs off when recovery is %s", async (mode) => {
    const test = await setup(mode);
    expect(test.pushPendingMutations).toHaveBeenCalledTimes(1);
    expect(test.onRetryScheduled).toHaveBeenLastCalledWith({ attempt: 1, delayMs: 1_000 });
    expect(test.onIdle).not.toHaveBeenCalled();
    expect(await test.store.getDirtyEntryMutation("note")).toMatchObject(test.mutation);

    // Cursor notifications and local edits must not bypass the retry timer.
    test.loop.requestPull(101);
    test.loop.notifyLocalChange();
    await vi.advanceTimersByTimeAsync(999);
    expect(test.pushPendingMutations).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(test.pushPendingMutations).toHaveBeenCalledTimes(2);
    expect(test.onRetryScheduled).toHaveBeenLastCalledWith({ attempt: 2, delayMs: 2_000 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(test.onRetryScheduled).toHaveBeenLastCalledWith({ attempt: 3, delayMs: 4_000 });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(test.pushPendingMutations).toHaveBeenCalledTimes(4);
    expect(test.onRetryScheduled).toHaveBeenLastCalledWith({ attempt: 4, delayMs: 4_000 });
    expect(test.onError).toHaveBeenCalledTimes(4);
    expect(await test.store.getDirtyEntryMutation("note")).toMatchObject(test.mutation);

    // A later successful recovery clears the backoff and completes the queue.
    test.recoverEntryStates.mockImplementation(async () => {
      await test.store.clearDirtyEntryByMutationId(test.mutation.mutationId);
    });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await test.store.listDirtyEntries()).toEqual([]);
    expect(test.onIdle).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    test.loop.stop();
    await test.store.close();
  });

  it("does not reset backoff for unrelated successful commits or a new mutation ID on the same old base", async () => {
    const test = await setup("unchanged");
    await test.store.replaceDirtyEntry({ ...test.mutation, mutationId: "newer-local-edit" });
    test.pushPendingMutations.mockResolvedValue(createPushResult({
      mutationsPushed: 1, mutationsRequeued: 1, cursor: 101,
      shouldPullAfterPush: true, hasMore: true,
      staleMutations: [{ entryId: "note", baseRevision: 3 }],
    }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(test.onRetryScheduled).toHaveBeenLastCalledWith({ attempt: 2, delayMs: 2_000 });
    expect(await test.store.getDirtyEntryMutation("note")).toMatchObject({ mutationId: "newer-local-edit", baseRevision: 3 });
    expect(test.onIdle).not.toHaveBeenCalled();
    test.loop.stop();
    await test.store.close();
  });
});
