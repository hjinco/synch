import { describe, expect, it, vi } from "vitest";

import { createTestSyncStore } from "../../../../test-support/in-memory-sync-store";
import { SyncAutoLoop } from "../../auto-sync";
import {
  createPushResult,
  createRealtimeClient,
  createToken,
} from "./helpers";
import type {
  SyncRealtimeCallbacks,
  SyncRealtimeSession,
} from "../../../remote/realtime-client";

describe("SyncAutoLoop local changes", () => {
  it("keeps local changes pending until a periodic sync is requested", async () => {
    const store = createTestSyncStore();
    const pushPendingMutations = vi.fn(async () => createPushResult());
    const onSyncDeferred = vi.fn();
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pullOnce: vi.fn(async () => {}),
      pushPendingMutations,
      realtimeClient: createRealtimeClient(),
      shouldDeferSyncWork: () => true,
      onSyncDeferred,
    });

    await autoLoop.start();
    autoLoop.notifyLocalChange();
    await Promise.resolve();

    expect(pushPendingMutations).not.toHaveBeenCalled();
    expect(onSyncDeferred).toHaveBeenCalledTimes(1);

    await autoLoop.syncNow();

    expect(pushPendingMutations).toHaveBeenCalledTimes(1);
    autoLoop.stop();
    await store.close();
  });

  it("defers failed periodic work instead of retrying it immediately", async () => {
    const store = createTestSyncStore();
    const pushPendingMutations = vi.fn(async () => {
      throw new Error("push failed");
    });
    const onSyncDeferred = vi.fn();
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pullOnce: vi.fn(async () => {}),
      pushPendingMutations,
      realtimeClient: createRealtimeClient(),
      shouldDeferSyncWork: () => true,
      onSyncDeferred,
    });

    await autoLoop.start();
    await autoLoop.syncNow();
    await Promise.resolve();

    expect(pushPendingMutations).toHaveBeenCalledTimes(1);
    expect(onSyncDeferred).toHaveBeenCalledTimes(1);
    autoLoop.stop();
    await store.close();
  });

  it("receives realtime cursor and storage updates while file sync is deferred", async () => {
    const store = createTestSyncStore();
    const pushPendingMutations = vi.fn(async () => createPushResult());
    const pullOnce = vi.fn(async () => {});
    const onStorageStatusChange = vi.fn();
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
      shouldDeferSyncWork: () => true,
      onStorageStatusChange,
    });

    autoLoop.setStorageStatusWatching(true);
    await autoLoop.start();
    (callbacks as SyncRealtimeCallbacks | null)?.onCursorAdvanced(2);
    (callbacks as SyncRealtimeCallbacks | null)?.onStorageStatusUpdated({
      storageUsedBytes: 123,
      storageLimitBytes: 456,
    });
    await Promise.resolve();

    expect(pullOnce).not.toHaveBeenCalled();
    expect(pushPendingMutations).not.toHaveBeenCalled();
    expect(onStorageStatusChange).toHaveBeenLastCalledWith({
      storageUsedBytes: 123,
      storageLimitBytes: 456,
    });

    await autoLoop.syncNow();

    expect(pullOnce).toHaveBeenCalledTimes(1);
    autoLoop.stop();
    await store.close();
  });

  it("runs ad-hoc realtime work on the active session", async () => {
    const store = createTestSyncStore();
    const pushPendingMutations = vi.fn(async () => createPushResult());
    const pullOnce = vi.fn(async () => {});
    let openCount = 0;
    let session: SyncRealtimeSession | null = null;
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations,
      pullOnce,
      realtimeClient: createRealtimeClient(
        () => {
          openCount += 1;
        },
        (nextSession) => {
          session = nextSession;
        },
      ),
    });

    await autoLoop.start();
    const result = await autoLoop.withRealtimeSession(async (activeSession) => {
      expect(activeSession).toBe(session);
      return "done";
    });

    expect(result).toBe("done");
    expect(openCount).toBe(1);
    autoLoop.stop();
    await store.close();
  });

  it("debounces local changes into a single push", async () => {
    vi.useFakeTimers();

    const store = createTestSyncStore();
    const pushPendingMutations = vi.fn(async () => createPushResult());
    const pullOnce = vi.fn(async () => {});
    let session: SyncRealtimeSession | null = null;
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations,
      pullOnce,
      realtimeClient: createRealtimeClient(undefined, (nextSession) => {
        session = nextSession;
      }),
      pushDebounceMs: 100,
    });

    await autoLoop.start();
    autoLoop.notifyLocalChange();
    autoLoop.notifyLocalChange();
    autoLoop.notifyLocalChange();

    await vi.advanceTimersByTimeAsync(100);

    expect(pushPendingMutations).toHaveBeenCalledTimes(1);
    expect(pushPendingMutations).toHaveBeenCalledWith(session);
    expect(pullOnce).toHaveBeenCalledTimes(0);
    autoLoop.stop();
    await store.close();
  });

  it("flushes a debounced push immediately when manual sync is requested", async () => {
    vi.useFakeTimers();
    const store = createTestSyncStore();
    const pushPendingMutations = vi.fn(async () => createPushResult());
    const pullOnce = vi.fn(async () => {});
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations,
      pullOnce,
      realtimeClient: createRealtimeClient(),
      pushDebounceMs: 1_000,
    });

    await autoLoop.start();
    autoLoop.notifyLocalChange();
    await autoLoop.syncNow();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(pushPendingMutations).toHaveBeenCalledTimes(1);
    expect(pullOnce).toHaveBeenCalledTimes(1);
    autoLoop.stop();
    await store.close();
  });

  it("pushes file-size blocked mutations unblocked by the current session policy", async () => {
    const store = createTestSyncStore();
    const pushPendingMutations = vi.fn(async () => createPushResult());
    const unblockFileSizeBlockedMutations = vi.fn(async () => 1);
    const pullOnce = vi.fn(async () => {});
    let session: SyncRealtimeSession | null = null;
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations,
      unblockFileSizeBlockedMutations,
      pullOnce,
      realtimeClient: createRealtimeClient(undefined, (nextSession) => {
        session = nextSession;
      }),
    });

    await autoLoop.start();
    await Promise.resolve();

    expect(unblockFileSizeBlockedMutations).toHaveBeenCalledWith(session);
    expect(pushPendingMutations).toHaveBeenCalledWith(session);
    expect(pullOnce).toHaveBeenCalledTimes(0);
    autoLoop.stop();
    await store.close();
  });

  it("retries file-size blocked mutations after policy updates", async () => {
    const store = createTestSyncStore();
    const pushPendingMutations = vi.fn(async () => createPushResult());
    const unblockFileSizeBlockedMutations = vi
      .fn()
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1);
    const pullOnce = vi.fn(async () => {});
    let callbacks: SyncRealtimeCallbacks | null = null;
    let session: SyncRealtimeSession | null = null;
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations,
      unblockFileSizeBlockedMutations,
      pullOnce,
      realtimeClient: createRealtimeClient(
        (nextCallbacks) => {
          callbacks = nextCallbacks;
        },
        (nextSession) => {
          session = nextSession;
        },
      ),
    });

    await autoLoop.start();
    (callbacks as SyncRealtimeCallbacks | null)?.onPolicyUpdated(
      {
        storageLimitBytes: 1_000_000_000,
        maxFileSizeBytes: 5_000_000,
      },
      {
        storageUsedBytes: 24_300_000,
        storageLimitBytes: 1_000_000_000,
      },
    );
    await vi.waitFor(() => {
      expect(pushPendingMutations).toHaveBeenCalledWith(session);
    });

    expect(unblockFileSizeBlockedMutations).toHaveBeenCalledTimes(2);
    expect(unblockFileSizeBlockedMutations).toHaveBeenLastCalledWith(session);
    expect(pullOnce).toHaveBeenCalledTimes(0);
    autoLoop.stop();
    await store.close();
  });

  it("reopens the realtime session after file-size unblock initialization fails", async () => {
    vi.useFakeTimers();

    const store = createTestSyncStore();
    const pushPendingMutations = vi.fn(async () => createPushResult());
    const unblockFileSizeBlockedMutations = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient unblock failure"))
      .mockResolvedValueOnce(0);
    const pullOnce = vi.fn(async () => {});
    const onError = vi.fn();
    const closedSessions: SyncRealtimeSession[] = [];
    let openCount = 0;
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations,
      unblockFileSizeBlockedMutations,
      pullOnce,
      realtimeClient: createRealtimeClient(
        () => {
          openCount += 1;
        },
        (session) => {
          const close = session.close.bind(session);
          session.close = () => {
            closedSessions.push(session);
            close();
          };
        },
      ),
      reconnectDelayMs: 100,
      onError,
    });

    await autoLoop.start();
    await vi.advanceTimersByTimeAsync(100);

    expect(openCount).toBe(2);
    expect(unblockFileSizeBlockedMutations).toHaveBeenCalledTimes(2);
    expect(closedSessions).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(1);
    autoLoop.stop();
    await store.close();
  });

  it("keeps pushing when the push service reports more pending work", async () => {
    vi.useFakeTimers();

    const store = createTestSyncStore();
    const pushPendingMutations = vi
      .fn()
      .mockResolvedValueOnce(createPushResult({ hasMore: true }))
      .mockResolvedValueOnce(createPushResult({ hasMore: false }));
    const pullOnce = vi.fn(async () => {});
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations,
      pullOnce,
      realtimeClient: createRealtimeClient(),
      pushDebounceMs: 100,
    });

    await autoLoop.start();
    autoLoop.notifyLocalChange();

    await vi.advanceTimersByTimeAsync(100);

    expect(pushPendingMutations).toHaveBeenCalledTimes(2);
    expect(pullOnce).toHaveBeenCalledTimes(0);
    autoLoop.stop();
    await store.close();
  });

  it("stops auto sync instead of re-pushing when storage quota is exceeded", async () => {
    vi.useFakeTimers();

    const store = createTestSyncStore();
    const pushPendingMutations = vi.fn(async () =>
      createPushResult({
        hasMore: true,
        stopReason: "storage_quota_exceeded",
      }),
    );
    const pullOnce = vi.fn(async () => {});
    const onStorageQuotaExceeded = vi.fn(async () => {});
    const closedSessions: SyncRealtimeSession[] = [];
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations,
      pullOnce,
      realtimeClient: createRealtimeClient(undefined, (session) => {
        const close = session.close.bind(session);
        session.close = () => {
          closedSessions.push(session);
          close();
        };
      }),
      pushDebounceMs: 100,
      onStorageQuotaExceeded,
    });

    await autoLoop.start();
    autoLoop.notifyLocalChange();

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(pushPendingMutations).toHaveBeenCalledTimes(1);
    expect(pullOnce).toHaveBeenCalledTimes(0);
    expect(onStorageQuotaExceeded).toHaveBeenCalledTimes(1);
    expect(closedSessions).toHaveLength(1);
    await store.close();
  });
});
