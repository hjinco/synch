import { describe, expect, it, vi } from "vitest";

import { createTestSyncStore } from "../../../../test-support/in-memory-sync-store";
import {
  SyncRealtimeError,
  type SyncRealtimeCallbacks,
} from "../../../remote/realtime-client";
import { SyncAutoLoop } from "../../auto-sync";
import {
  createPushResult,
  createRealtimeClient,
  createToken,
} from "./helpers";

describe("SyncAutoLoop remote cursors", () => {
  it("pulls after reconnecting when the server cursor is ahead of the local cursor", async () => {
    const store = createTestSyncStore();
    await store.setCursor(10);
    const pushPendingMutations = vi.fn(async () => createPushResult());
    const pullOnce = vi.fn(async () => {});
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations,
      pullOnce,
      realtimeClient: createRealtimeClient(undefined, undefined, 11),
    });

    await autoLoop.start();
    await Promise.resolve();

    expect(pushPendingMutations).toHaveBeenCalledTimes(0);
    expect(pullOnce).toHaveBeenCalledTimes(1);
    expect(pullOnce).toHaveBeenCalledWith(expect.objectContaining({ serverCursor: 11 }));
    autoLoop.stop();
    await store.close();
  });

  it("does not pull after reconnecting when the server cursor matches the local cursor", async () => {
    const store = createTestSyncStore();
    await store.setCursor(10);
    const pushPendingMutations = vi.fn(async () => createPushResult());
    const pullOnce = vi.fn(async () => {});
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations,
      pullOnce,
      realtimeClient: createRealtimeClient(undefined, undefined, 10),
    });

    await autoLoop.start();
    await Promise.resolve();

    expect(pushPendingMutations).toHaveBeenCalledTimes(0);
    expect(pullOnce).toHaveBeenCalledTimes(0);
    autoLoop.stop();
    await store.close();
  });

  it("stops without reconnecting when the local cursor is ahead of the server", async () => {
    vi.useFakeTimers();

    const store = createTestSyncStore();
    await store.setCursor(10);
    const pushPendingMutations = vi.fn(async () => createPushResult());
    const pullOnce = vi.fn(async () => {});
    const onError = vi.fn();
    const openSession = vi.fn(
      createRealtimeClient(undefined, undefined, 9).openSession,
    );
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations,
      pullOnce,
      realtimeClient: { openSession },
      reconnectDelayMs: 100,
      onError,
    });

    await autoLoop.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(openSession).toHaveBeenCalledTimes(1);
    expect(pushPendingMutations).not.toHaveBeenCalled();
    expect(pullOnce).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      code: "cursor_ahead_of_server",
    });
    autoLoop.stop();
    await store.close();
  });

  it("reports a server cursor mismatch once and does not reconnect", async () => {
    vi.useFakeTimers();

    const store = createTestSyncStore();
    await store.setCursor(10);
    const cursorError = new SyncRealtimeError(
      "cursor_ahead_of_server",
      "simulated cursor mismatch",
    );
    const openSession = vi.fn(async (
      _apiBaseUrl: string,
      _token: ReturnType<typeof createToken>,
      _lastKnownCursor: number,
      callbacks: SyncRealtimeCallbacks,
    ) => {
      callbacks.onError(cursorError);
      throw cursorError;
    });
    const onError = vi.fn();
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations: vi.fn(async () => createPushResult()),
      pullOnce: vi.fn(async () => {}),
      realtimeClient: { openSession },
      reconnectDelayMs: 100,
      onError,
    });

    await autoLoop.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(openSession).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(cursorError);
    autoLoop.stop();
    await store.close();
  });

  it("stops without retrying when pull reports that the cursor is ahead", async () => {
    vi.useFakeTimers();

    const store = createTestSyncStore();
    await store.setCursor(10);
    const cursorError = new SyncRealtimeError(
      "cursor_ahead_of_server",
      "simulated cursor mismatch",
    );
    const pullOnce = vi.fn(async () => {
      throw cursorError;
    });
    const onError = vi.fn();
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations: vi.fn(async () => createPushResult()),
      pullOnce,
      realtimeClient: createRealtimeClient(undefined, undefined, 10),
      syncRetryBaseDelayMs: 100,
      onError,
    });

    await autoLoop.start();
    autoLoop.requestPull(11);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(pullOnce).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(cursorError);
    autoLoop.stop();
    await store.close();
  });

  it("pulls when the realtime socket reports cursor advancement", async () => {
    const store = createTestSyncStore();
    const pushPendingMutations = vi.fn(async () => createPushResult());
    const pullOnce = vi.fn(async () => {});
    let callbacks: SyncRealtimeCallbacks | null = null;
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations,
      pullOnce,
      realtimeClient: createRealtimeClient((nextCallbacks) => {
        callbacks = nextCallbacks;
      }),
    });

    await autoLoop.start();
    (callbacks as SyncRealtimeCallbacks | null)?.onCursorAdvanced(12);
    await Promise.resolve();
    await Promise.resolve();

    expect(pushPendingMutations).toHaveBeenCalledTimes(0);
    expect(pullOnce).toHaveBeenCalledTimes(1);
    expect(pullOnce).toHaveBeenCalledWith(expect.objectContaining({ serverCursor: 0 }));
    autoLoop.stop();
    await store.close();
  });
});
