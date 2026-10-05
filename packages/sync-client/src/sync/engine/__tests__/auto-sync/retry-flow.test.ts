import { SyncBlobUploadError, SyncBlobDownloadError } from "../../../remote/blob-client";
import { ApiRequestError } from "../../../../http/request";
import { describe, expect, it, vi } from "vitest";

import { createTestSyncStore } from "../../../../test-support/in-memory-sync-store";
import {
  SyncRealtimeConnectionError,
  SyncRealtimeError,
  type SyncRealtimeCallbacks,
} from "../../../remote/realtime-client";
import { SyncAutoLoop } from "../../auto-sync";
import {
  createFailingRealtimeClient,
  createPushResult,
  createRealtimeClient,
  createToken,
} from "./helpers";

describe("SyncAutoLoop retry flow", () => {
  it("keeps an active realtime session open when resuming", async () => {
    const store = createTestSyncStore();
    const callbacks: SyncRealtimeCallbacks[] = [];
    const closeSession = vi.fn();
    const pushPendingMutations = vi.fn(async () => createPushResult());
    const pullOnce = vi.fn(async () => {});
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations,
      pullOnce,
      realtimeClient: createRealtimeClient(
        (nextCallbacks) => {
          callbacks.push(nextCallbacks);
        },
        (session) => {
          session.close = closeSession;
        },
      ),
    });

    await autoLoop.start();

    expect(callbacks).toHaveLength(1);

    await autoLoop.resumeConnection();

    expect(callbacks).toHaveLength(1);
    expect(closeSession).not.toHaveBeenCalled();

    autoLoop.stop();
    await store.close();
  });

  it("resumes immediately while waiting for reconnect backoff", async () => {
    vi.useFakeTimers();

    const store = createTestSyncStore();
    const callbacks: SyncRealtimeCallbacks[] = [];
    const pushPendingMutations = vi.fn(async () => createPushResult());
    const pullOnce = vi.fn(async () => {});
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations,
      pullOnce,
      realtimeClient: createRealtimeClient((nextCallbacks) => {
        callbacks.push(nextCallbacks);
      }),
      reconnectDelayMs: 1_000,
    });

    await autoLoop.start();
    expect(callbacks).toHaveLength(1);

    callbacks[0]?.onClose({
      code: 1006,
      reason: "connection closed",
    });
    await autoLoop.resumeConnection();

    expect(callbacks).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(callbacks).toHaveLength(2);

    autoLoop.stop();
    await store.close();
  });

  it("does not open a realtime session when stopped resume is requested", async () => {
    const openSession = vi.fn(async () => {
      throw new Error("should not open");
    });
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => null,
      pushPendingMutations: vi.fn(async () => createPushResult()),
      pullOnce: vi.fn(async () => {}),
      realtimeClient: {
        openSession,
      },
    });

    await autoLoop.resumeConnection();

    expect(openSession).not.toHaveBeenCalled();
  });

  it("opens a new realtime session after the active socket closes", async () => {
    vi.useFakeTimers();

    const store = createTestSyncStore();
    const callbacks: SyncRealtimeCallbacks[] = [];
    const states: string[] = [];
    const pushPendingMutations = vi.fn(async () => createPushResult());
    const pullOnce = vi.fn(async () => {});
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations,
      pullOnce,
      realtimeClient: createRealtimeClient((nextCallbacks) => {
        callbacks.push(nextCallbacks);
      }),
      reconnectDelayMs: 1_000,
      onConnectionStateChange(state) {
        states.push(state);
      },
    });

    await autoLoop.start();
    expect(callbacks).toHaveLength(1);

    callbacks[0]?.onClose({
      code: 1006,
      reason: "connection closed",
    });
    expect(states).toContain("reconnecting");

    await vi.advanceTimersByTimeAsync(999);
    expect(callbacks).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(callbacks).toHaveLength(2);
    expect(states[states.length - 1]).toBe("live");

    autoLoop.stop();
    await store.close();
  });

  it("stops instead of reconnecting when the active remote vault becomes unavailable", async () => {
    vi.useFakeTimers();

    const store = createTestSyncStore();
    const callbacks: SyncRealtimeCallbacks[] = [];
    const onRemoteVaultUnavailable = vi.fn();
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations: vi.fn(async () => createPushResult()),
      pullOnce: vi.fn(async () => {}),
      realtimeClient: createRealtimeClient((nextCallbacks) => {
        callbacks.push(nextCallbacks);
      }),
      reconnectDelayMs: 1_000,
      onRemoteVaultUnavailable,
    });

    await autoLoop.start();

    callbacks[0]?.onClose({
      code: 4403,
      reason: "vault deleted",
    });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(callbacks).toHaveLength(1);
    expect(onRemoteVaultUnavailable).toHaveBeenCalledTimes(1);
    expect(onRemoteVaultUnavailable.mock.calls[0]?.[0]).toMatchObject({
      remoteVaultId: "vault-1",
      reason: "not_found",
    });

    await store.close();
  });

  it("reconnects when a non-unavailable close reason mentions the local vault", async () => {
    vi.useFakeTimers();

    const store = createTestSyncStore();
    const callbacks: SyncRealtimeCallbacks[] = [];
    const onRemoteVaultUnavailable = vi.fn();
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations: vi.fn(async () => createPushResult()),
      pullOnce: vi.fn(async () => {}),
      realtimeClient: createRealtimeClient((nextCallbacks) => {
        callbacks.push(nextCallbacks);
      }),
      reconnectDelayMs: 1_000,
      onRemoteVaultUnavailable,
    });

    await autoLoop.start();

    callbacks[0]?.onClose({
      code: 0,
      reason: "connection replaced by a newer sync session for this local vault",
    });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(callbacks).toHaveLength(2);
    expect(onRemoteVaultUnavailable).not.toHaveBeenCalled();

    autoLoop.stop();
    await store.close();
  });

  it.each([1013, 4403])("retains the vault and stops reconnecting after a repair pause (%i)", async (code) => {
    vi.useFakeTimers();

    const store = createTestSyncStore();
    const callbacks: SyncRealtimeCallbacks[] = [];
    const onRemoteVaultUnavailable = vi.fn();
    const onTerminalStop = vi.fn();
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations: vi.fn(async () => createPushResult()),
      pullOnce: vi.fn(async () => {}),
      realtimeClient: createRealtimeClient((nextCallbacks) => {
        callbacks.push(nextCallbacks);
      }),
      reconnectDelayMs: 1_000,
      onRemoteVaultUnavailable,
      onTerminalStop,
    });

    await autoLoop.start();

    callbacks[0]?.onClose({
      code,
      reason: "sync paused for vault repair",
    });
    await vi.advanceTimersByTimeAsync(300_000);

    expect(callbacks).toHaveLength(1);
    expect(autoLoop.isActive()).toBe(false);
    expect(onTerminalStop).toHaveBeenCalledExactlyOnceWith({ type: "sync_paused", error: expect.any(Error) });

    // An explicit restart is still possible after the operator resumes the vault.
    await autoLoop.start();
    expect(callbacks).toHaveLength(2);
    expect(onRemoteVaultUnavailable).not.toHaveBeenCalled();

    autoLoop.stop();
    await store.close();
  });

  it("reconnects without reporting a realtime connection error", async () => {
    vi.useFakeTimers();

    const store = createTestSyncStore();
    const callbacks: SyncRealtimeCallbacks[] = [];
    const onError = vi.fn();
    const states: string[] = [];
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations: vi.fn(async () => createPushResult()),
      pullOnce: vi.fn(async () => {}),
      realtimeClient: createRealtimeClient((nextCallbacks) => {
        callbacks.push(nextCallbacks);
      }),
      reconnectDelayMs: 1_000,
      onError,
      onConnectionStateChange(state) {
        states.push(state);
      },
    });

    await autoLoop.start();

    callbacks[0]?.onError(
      new SyncRealtimeConnectionError("sync websocket connection failed"),
    );
    callbacks[0]?.onClose({
      code: 1006,
      reason: "connection closed",
    });

    expect(onError).not.toHaveBeenCalled();
    expect(states).toContain("reconnecting");

    await vi.advanceTimersByTimeAsync(1_000);

    expect(callbacks).toHaveLength(2);
    autoLoop.stop();
    await store.close();
  });

  it("keeps realtime request closures out of user-visible error reporting", async () => {
    vi.useFakeTimers();

    const store = createTestSyncStore();
    const pushPendingMutations = vi
      .fn()
      .mockRejectedValueOnce(
        new SyncRealtimeConnectionError(
          "sync websocket closed before the request completed",
        ),
      )
      .mockResolvedValue(createPushResult());
    const onError = vi.fn();
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations,
      pullOnce: vi.fn(async () => {}),
      realtimeClient: createRealtimeClient(),
      pushDebounceMs: 100,
      syncRetryBaseDelayMs: 1_000,
      syncRetryMaxDelayMs: 1_000,
      onError,
    });

    await autoLoop.start();
    autoLoop.notifyLocalChange();

    await vi.advanceTimersByTimeAsync(100);

    expect(pushPendingMutations).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(pushPendingMutations).toHaveBeenCalledTimes(2);
    autoLoop.stop();
    await store.close();
  });

  it("retries a failed auto push with backoff", async () => {
    vi.useFakeTimers();

    const store = createTestSyncStore();
    const pushPendingMutations = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(createPushResult());
    const pullOnce = vi.fn(async () => {});
    const onError = vi.fn();
    const onIdle = vi.fn();
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations,
      pullOnce,
      realtimeClient: createRealtimeClient(),
      pushDebounceMs: 100,
      syncRetryBaseDelayMs: 1_000,
      syncRetryMaxDelayMs: 1_000,
      onError,
      onIdle,
    });

    await autoLoop.start();
    onIdle.mockClear();
    autoLoop.notifyLocalChange();

    await vi.advanceTimersByTimeAsync(100);

    expect(pushPendingMutations).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onIdle).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(999);

    expect(pushPendingMutations).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);

    expect(pushPendingMutations).toHaveBeenCalledTimes(2);
    expect(pullOnce).toHaveBeenCalledTimes(0);
    expect(onIdle).toHaveBeenCalledTimes(1);
    autoLoop.stop();
    await store.close();
  });

  it("keeps pending remote changes queued when realtime reconnect blocks sync", async () => {
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
      realtimeClient: createFailingRealtimeClient(),
      pushDebounceMs: 100,
      reconnectDelayMs: 3_000,
    });

    await autoLoop.start();
    autoLoop.requestPull(9);
    autoLoop.notifyLocalChange();

    await vi.advanceTimersByTimeAsync(100);

    expect(pushPendingMutations).toHaveBeenCalledTimes(0);
    expect(pullOnce).toHaveBeenCalledTimes(0);
    const pendingWork = (
      autoLoop as unknown as {
        pendingWork: { push: boolean; pullTargetCursor: number | null };
      }
    ).pendingWork;
    expect(pendingWork.push).toBe(true);
    expect(pendingWork.pullTargetCursor).toBe(9);
    autoLoop.stop();
    await store.close();
  });

  it("retries only pull when pull fails after a successful push", async () => {
    vi.useFakeTimers();

    const store = createTestSyncStore();
    const pushPendingMutations = vi.fn(async () =>
      createPushResult({
        shouldPullAfterPush: true,
      }),
    );
    const pullOnce = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({});
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations,
      pullOnce,
      realtimeClient: createRealtimeClient(),
      pushDebounceMs: 100,
      syncRetryBaseDelayMs: 1_000,
      syncRetryMaxDelayMs: 1_000,
    });

    await autoLoop.start();
    autoLoop.notifyLocalChange();

    await vi.advanceTimersByTimeAsync(100);

    expect(pushPendingMutations).toHaveBeenCalledTimes(1);
    expect(pullOnce).toHaveBeenCalledTimes(1);
    expect(pullOnce).toHaveBeenLastCalledWith(expect.objectContaining({ serverCursor: 0 }));

    await vi.advanceTimersByTimeAsync(1_000);

    expect(pushPendingMutations).toHaveBeenCalledTimes(1);
    expect(pullOnce).toHaveBeenCalledTimes(2);
    expect(pullOnce).toHaveBeenLastCalledWith(expect.objectContaining({ serverCursor: 0 }));
    autoLoop.stop();
    await store.close();
  });

  it("pulls before retrying a push deferred by a stale revision", async () => {
    vi.useFakeTimers();

    const store = createTestSyncStore();
    const calls: string[] = [];
    const pushPendingMutations = vi
      .fn()
      .mockImplementationOnce(async () => {
        calls.push("push:stale");
        return createPushResult({
          cursor: 0,
          mutationsPushed: 0,
          mutationsRequeued: 1,
          filesCreatedOrUpdated: 0,
          shouldPullAfterPush: true,
          hasMore: true,
        });
      })
      .mockImplementationOnce(async () => {
        calls.push("push:retry");
        return createPushResult({
          cursor: 2,
          mutationsPushed: 1,
          filesCreatedOrUpdated: 1,
          shouldPullAfterPush: false,
          hasMore: false,
        });
      });
    const pullOnce = vi.fn(async () => {
      calls.push("pull");
    });
    const onIdle = vi.fn();
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations,
      pullOnce,
      realtimeClient: createRealtimeClient(),
      pushDebounceMs: 100,
      onIdle,
    });

    await autoLoop.start();
    onIdle.mockClear();
    autoLoop.notifyLocalChange();

    await vi.advanceTimersByTimeAsync(100);

    expect(calls).toEqual(["push:stale", "pull", "push:retry"]);
    expect(pushPendingMutations).toHaveBeenCalledTimes(2);
    expect(pullOnce).toHaveBeenCalledTimes(1);
    expect(onIdle).toHaveBeenCalledTimes(1);

    autoLoop.stop();
    await store.close();
  });
});


describe("server pause terminal handling", () => {
  const errors = [
    new ApiRequestError(503, "sync_paused", "paused"),
    new ApiRequestError(403, "forbidden", "vault sync is temporarily paused for repair"),
    new SyncRealtimeError("sync_paused", "paused"),
  ];

  it.each(errors)("stops token retries for %s", async (error) => {
    vi.useFakeTimers();
    const store = createTestSyncStore();
    const getSyncToken = vi.fn(async () => { throw error; });
    const onTerminalStop = vi.fn();
    const onRemoteVaultUnavailable = vi.fn();
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787", getSyncToken, getSyncStore: () => store,
      pushPendingMutations: vi.fn(async () => createPushResult()), pullOnce: vi.fn(),
      realtimeClient: createRealtimeClient(), onTerminalStop, onRemoteVaultUnavailable,
    });
    await autoLoop.start();
    await vi.advanceTimersByTimeAsync(300_000);
    await autoLoop.resumeConnection();
    expect(getSyncToken).toHaveBeenCalledTimes(1);
    expect(onTerminalStop).toHaveBeenCalledExactlyOnceWith({ type: "sync_paused", error });
    expect(onRemoteVaultUnavailable).not.toHaveBeenCalled();
    expect(autoLoop.isActive()).toBe(false);
    await store.close();
  });

  it("stops pending work on a session error and only notifies once when close follows", async () => {
    vi.useFakeTimers();
    const store = createTestSyncStore();
    const callbacks: SyncRealtimeCallbacks[] = [];
    const pushPendingMutations = vi.fn(async () => createPushResult());
    const onTerminalStop = vi.fn();
    const onError = vi.fn();
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787", getSyncToken: async () => createToken(), getSyncStore: () => store,
      pushPendingMutations, pullOnce: vi.fn(), realtimeClient: createRealtimeClient(next => callbacks.push(next)), onTerminalStop, onError,
    });
    await autoLoop.start();
    autoLoop.notifyLocalChange();
    callbacks[0].onError(new SyncRealtimeError("sync_paused", "paused"));
    callbacks[0].onClose({ code: 1013, reason: "sync paused for vault repair" });
    autoLoop.notifyLocalChange();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(callbacks).toHaveLength(1);
    expect(pushPendingMutations).not.toHaveBeenCalled();
    expect(onTerminalStop).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    await store.close();
  });

  it.each(["push", "pull"])("does not retry %s after a server pause", async (direction) => {
    vi.useFakeTimers();
    const store = createTestSyncStore();
    const error = direction === "push"
      ? new SyncBlobUploadError(503, "sync_paused", "paused")
      : new SyncBlobDownloadError(503, "paused", "sync_paused");
    const mutation = { entryId: "note", mutationId: "local-edit", baseRevision: 3,
      op: "upsert" as const, blobId: "local-blob", hash: "local-hash", encryptedMetadata: "encrypted", createdAt: 1 };
    await store.markEntryDirty(mutation);
    const pushPendingMutations = vi.fn(async () => { if (direction === "push") throw error; return createPushResult(); });
    const pullOnce = vi.fn(async () => { if (direction === "pull") throw error; });
    const onTerminalStop = vi.fn();
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787", getSyncToken: async () => createToken(), getSyncStore: () => store,
      pushPendingMutations, pullOnce, realtimeClient: createRealtimeClient(), onTerminalStop,
    });
    await autoLoop.start();
    expect(await autoLoop.syncNow()).toBe(false);
    const calls = [pushPendingMutations.mock.calls.length, pullOnce.mock.calls.length];
    await vi.advanceTimersByTimeAsync(300_000);
    expect([pushPendingMutations.mock.calls.length, pullOnce.mock.calls.length]).toEqual(calls);
    expect(onTerminalStop).toHaveBeenCalledExactlyOnceWith({ type: "sync_paused", error });
    expect(autoLoop.isActive()).toBe(false);
    expect(await store.getDirtyEntryMutation("note")).toEqual(mutation);
    await store.close();
  });
});
