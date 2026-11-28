import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestSyncStore } from "../../../../test-support/in-memory-sync-store";
import {
  SyncRealtimeError,
  type SyncRealtimeCallbacks,
  type SyncRealtimeSession,
} from "../../../remote/realtime-client";
import { SyncAutoLoop, type SyncAutoLoopDeps } from "../../auto-sync";
import type { PushPendingMutationsResult } from "../../push-service";
import { createPushResult, createRealtimeClient, createToken } from "./helpers";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createLoop(overrides: Partial<SyncAutoLoopDeps> = {}) {
  const store = createTestSyncStore();
  const callbacks: SyncRealtimeCallbacks[] = [];
  const sessions: SyncRealtimeSession[] = [];
  const pullOnce = vi.fn(async () => {});
  const pushPendingMutations = vi.fn(async () => createPushResult());
  const onError = vi.fn();
  const onIdle = vi.fn();
  const onTerminalStop = vi.fn();
  const onStorageStatusChange = vi.fn();
  const onPresenceAvailabilityChanged = vi.fn();
  const onStorageQuotaExceeded = vi.fn();
  const autoLoop = new SyncAutoLoop({
    getApiBaseUrl: () => "http://127.0.0.1:8787",
    getSyncToken: async () => createToken(),
    getSyncStore: () => store,
    pullOnce,
    pushPendingMutations,
    realtimeClient: createRealtimeClient(
      (nextCallbacks) => callbacks.push(nextCallbacks),
      (session) => {
        session.close = vi.fn();
        sessions.push(session);
      },
    ),
    onError,
    onIdle,
    onTerminalStop,
    onStorageStatusChange,
    onPresenceAvailabilityChanged,
    onStorageQuotaExceeded,
    ...overrides,
  });
  cleanups.push(async () => {
    autoLoop.stop();
    await autoLoop.waitForInFlightDrain();
    await store.close();
  });
  return {
    store, autoLoop, callbacks, sessions, pullOnce, pushPendingMutations,
    onError, onIdle, onTerminalStop, onStorageStatusChange,
    onPresenceAvailabilityChanged, onStorageQuotaExceeded,
  };
}

async function seedSizeBlockedMutation(store: ReturnType<typeof createTestSyncStore>) {
  await store.markEntryDirty({
    entryId: "entry-blocked",
    mutationId: "mutation-blocked",
    op: "upsert",
    status: "blocked",
    blockedReason: "file_too_large",
    blockedEncryptedSizeBytes: 200,
    blockedMaxFileSizeBytes: 100,
    baseRevision: 0,
    blobId: "blob-blocked",
    hash: "hash-blocked",
    encryptedMetadata: "encrypted-metadata",
    createdAt: 1,
  });
}

describe("SyncAutoLoop lifecycle", () => {
  it("waits for connection initialization before completing manual sync", async () => {
    const enteredUnblock = deferred<void>();
    const finishUnblock = deferred<void>();
    const uploaded: string[] = [];
    const context = createLoop({
      shouldDeferSyncWork: () => true,
      unblockFileSizeBlockedMutations: async () => {
        enteredUnblock.resolve();
        await finishUnblock.promise;
        await context.store.unblockDirtyEntriesByReason("file_too_large");
        return 1;
      },
      pushPendingMutations: async () => {
        for (const mutation of await context.store.listDirtyEntries()) {
          uploaded.push(mutation.entryId);
          await context.store.clearDirtyEntryByMutationId(mutation.mutationId);
        }
        return createPushResult();
      },
    });
    await seedSizeBlockedMutation(context.store);
    const starting = context.autoLoop.start();
    await enteredUnblock.promise;
    let syncSettled = false;
    const syncing = context.autoLoop.syncNow().then((result) => {
      syncSettled = true;
      return result;
    });
    try {
      // Let runnable work finish while initialization remains explicitly blocked.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(syncSettled).toBe(false);
    } finally {
      finishUnblock.resolve();
      await starting;
      await syncing;
    }
    expect(await syncing).toBe(true);
    expect(uploaded).toEqual(["entry-blocked"]);
    expect(await context.store.listDirtyEntries()).toEqual([]);
  });

  it.each(["initialization", "policy update"])("keeps durable unblock notifications across reconnect during %s", async (phase) => {
    const changedStore = deferred<void>();
    const finishUnblock = deferred<void>();
    const uploaded: string[] = [];
    const context = createLoop({
      syncRetryBaseDelayMs: 10,
      unblockFileSizeBlockedMutations: async () => {
        const blocked = await context.store.listBlockedDirtyEntriesByReason("file_too_large");
        await context.store.unblockDirtyEntriesByReason("file_too_large");
        if (blocked.length > 0) {
          changedStore.resolve();
          await finishUnblock.promise;
        }
        return blocked.length;
      },
      pushPendingMutations: async () => {
        for (const mutation of await context.store.listDirtyEntries()) {
          uploaded.push(mutation.entryId);
          await context.store.clearDirtyEntryByMutationId(mutation.mutationId);
        }
        return createPushResult();
      },
    });
    if (phase === "initialization") await seedSizeBlockedMutation(context.store);
    const starting = context.autoLoop.start();
    if (phase === "policy update") {
      await starting;
      await seedSizeBlockedMutation(context.store);
      context.callbacks[0]!.onPolicyUpdated(
        { storageLimitBytes: 1_000, maxFileSizeBytes: 300 },
        { storageUsedBytes: 0, storageLimitBytes: 1_000 },
      );
    }
    await changedStore.promise;
    try {
      expect(await context.store.listDirtyEntries()).toHaveLength(1);
      context.autoLoop.reconnectNow();
      const reconnected = context.autoLoop.ensureRealtimeSession();
      finishUnblock.resolve();
      await Promise.all([starting, reconnected]);
      await context.autoLoop.resumeConnection();
      await vi.waitFor(() => expect(uploaded).toEqual(["entry-blocked"]));
      await context.autoLoop.waitForInFlightDrain();
      expect(await context.store.listDirtyEntries()).toEqual([]);
      expect(context.sessions).toHaveLength(2);
    } finally {
      finishUnblock.resolve();
      await starting;
    }
  });

  it("clears reconnect backoff when manual sync opens a replacement session", async () => {
    vi.useFakeTimers();
    const { autoLoop, callbacks, sessions } = createLoop();
    await autoLoop.start();
    callbacks[0]!.onClose({ code: 1006, reason: "connection closed" });

    expect(await autoLoop.syncNow()).toBe(true);
    expect(sessions).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stays stopped when connection initialization finishes after stop", async () => {
    const unblocked = deferred<number>();
    const unblockFileSizeBlockedMutations = vi.fn(() => unblocked.promise);
    const { autoLoop, onIdle, pushPendingMutations } = createLoop({ unblockFileSizeBlockedMutations });
    const start = autoLoop.start();
    await vi.waitFor(() => expect(unblockFileSizeBlockedMutations).toHaveBeenCalledTimes(1));

    autoLoop.stop();
    unblocked.resolve(1);
    await start;

    expect(autoLoop.isActive()).toBe(false);
    expect(await autoLoop.syncNow()).toBe(false);
    expect(onIdle).not.toHaveBeenCalled();
    expect(pushPendingMutations).not.toHaveBeenCalled();
  });

  it("does not open a socket when token acquisition finishes after stop", async () => {
    const token = deferred<ReturnType<typeof createToken>>();
    const { autoLoop, sessions } = createLoop({ getSyncToken: () => token.promise });
    const start = autoLoop.start();
    autoLoop.stop();
    token.resolve(createToken());
    await start;

    expect(sessions).toHaveLength(0);
    expect(autoLoop.isActive()).toBe(false);
  });

  it("acquires fresh credentials when restarted during token acquisition", async () => {
    const token = deferred<ReturnType<typeof createToken>>();
    const getSyncToken = vi.fn(async () => createToken()).mockImplementationOnce(() => token.promise);
    const { autoLoop, sessions } = createLoop({ getSyncToken });
    const firstStart = autoLoop.start();
    autoLoop.stop();
    const secondStart = autoLoop.start();
    token.resolve(createToken());
    await Promise.all([firstStart, secondStart]);

    expect(getSyncToken).toHaveBeenCalledTimes(2);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.close).not.toHaveBeenCalled();
    expect(autoLoop.isActive()).toBe(true);
  });

  it("discards a session that opens after its run was stopped and restarted", async () => {
    const opening = deferred<void>();
    const sessions: SyncRealtimeSession[] = [];
    const client = createRealtimeClient(undefined, (session) => {
      session.close = vi.fn();
      sessions.push(session);
    });
    const openSession = vi.fn(async (...args: Parameters<typeof client.openSession>) => {
      const session = await client.openSession(...args);
      if (sessions.length === 1) await opening.promise;
      return session;
    });
    const { autoLoop } = createLoop({ realtimeClient: { openSession } });
    const firstStart = autoLoop.start();
    await vi.waitFor(() => expect(openSession).toHaveBeenCalledTimes(1));
    autoLoop.stop();
    const secondStart = autoLoop.start();
    opening.resolve();
    await Promise.all([firstStart, secondStart]);

    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.close).toHaveBeenCalledTimes(1);
    expect(sessions[1]!.close).not.toHaveBeenCalled();
  });

  it("ignores events from a replaced connection", async () => {
    const onPresenceUpdated = vi.fn();
    const onPresenceCleared = vi.fn();
    const unblockFileSizeBlockedMutations = vi.fn(async () => 0);
    const context = createLoop({ onPresenceUpdated, onPresenceCleared, unblockFileSizeBlockedMutations });
    const { autoLoop, callbacks, sessions } = context;
    await autoLoop.start();
    autoLoop.reconnectNow();
    await autoLoop.ensureRealtimeSession();
    vi.clearAllMocks();

    const previous = callbacks[0]!;
    const status = { storageUsedBytes: 100, storageLimitBytes: 200 };
    previous.onCursorAdvanced(10);
    previous.onStorageStatusUpdated(status);
    previous.onPolicyUpdated({ maxFileSizeBytes: 100, storageLimitBytes: 200 }, status);
    previous.onPresenceUpdated({
      presenceId: "old", entryId: "entry", userId: "user", displayName: "User",
      selection: { anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 0 } },
    });
    previous.onPresenceCleared("old");
    previous.onPresenceAvailabilityChanged(true);
    previous.onClose({ code: 1006, reason: "old connection closed" });
    previous.onError(new SyncRealtimeError("sync_paused", "old connection paused"));
    await autoLoop.waitForInFlightDrain();

    expect(autoLoop.isActive()).toBe(true);
    expect(sessions[1]!.close).not.toHaveBeenCalled();
    expect(context.pullOnce).not.toHaveBeenCalled();
    expect(context.onStorageStatusChange).not.toHaveBeenCalled();
    expect(unblockFileSizeBlockedMutations).not.toHaveBeenCalled();
    expect(onPresenceUpdated).not.toHaveBeenCalled();
    expect(onPresenceCleared).not.toHaveBeenCalled();
    expect(context.onPresenceAvailabilityChanged).not.toHaveBeenCalled();
    expect(context.onError).not.toHaveBeenCalled();
    expect(context.onTerminalStop).not.toHaveBeenCalled();
  });

  it("does not start a push after stopping during a pull", async () => {
    const pulled = deferred<void>();
    const pullOnce = vi.fn(() => pulled.promise);
    const { autoLoop, pushPendingMutations, onIdle } = createLoop({ pullOnce });
    await autoLoop.start();
    onIdle.mockClear();
    const sync = autoLoop.syncNow();
    await vi.waitFor(() => expect(pullOnce).toHaveBeenCalledTimes(1));
    autoLoop.stop();
    pulled.resolve();

    expect(await sync).toBe(false);
    expect(pushPendingMutations).not.toHaveBeenCalled();
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("drains work requested by a new run after the previous pull finishes", async () => {
    const pulled = deferred<void>();
    const pullOnce = vi.fn(async () => {}).mockImplementationOnce(() => pulled.promise);
    const { autoLoop, sessions, pushPendingMutations } = createLoop({ pullOnce });
    await autoLoop.start();
    const oldSync = autoLoop.syncNow();
    await vi.waitFor(() => expect(pullOnce).toHaveBeenCalledTimes(1));
    autoLoop.stop();
    await autoLoop.start();
    const newSync = autoLoop.syncNow();
    pulled.resolve();

    expect(await oldSync).toBe(false);
    expect(await newSync).toBe(true);
    expect(pullOnce).toHaveBeenCalledTimes(2);
    expect(pullOnce).toHaveBeenLastCalledWith(sessions[1]);
    expect(pushPendingMutations).toHaveBeenCalledExactlyOnceWith(
      sessions[1], expect.any(Function), expect.any(Object),
    );
  });

  it("does not schedule work when an obsolete policy update finishes", async () => {
    const unblocked = deferred<number>();
    const unblockFileSizeBlockedMutations = vi.fn(async () => 0);
    const context = createLoop({ unblockFileSizeBlockedMutations });
    const { autoLoop, callbacks } = context;
    await autoLoop.start();
    unblockFileSizeBlockedMutations.mockImplementationOnce(() => unblocked.promise);
    callbacks[0]!.onPolicyUpdated(
      { storageLimitBytes: 200, maxFileSizeBytes: 100 },
      { storageUsedBytes: 50, storageLimitBytes: 200 },
    );
    autoLoop.stop();
    await autoLoop.start();
    unblocked.resolve(1);
    await unblocked.promise;
    await autoLoop.waitForInFlightDrain();

    expect(context.pushPendingMutations).not.toHaveBeenCalled();
    expect(autoLoop.isActive()).toBe(true);
  });

  it("invalidates callbacks before closing a replaced session", async () => {
    const { autoLoop, sessions, callbacks, onTerminalStop } = createLoop();
    await autoLoop.start();
    sessions[0]!.close = vi.fn(() => {
      callbacks[0]!.onClose({ code: 1013, reason: "sync paused for repair" });
    });
    autoLoop.reconnectNow();
    await autoLoop.ensureRealtimeSession();

    expect(autoLoop.isActive()).toBe(true);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.close).toHaveBeenCalledTimes(1);
    expect(onTerminalStop).not.toHaveBeenCalled();
  });

  it("does not repeat a terminal notification when a stopped request rejects", async () => {
    const pulled = deferred<void>();
    const pullOnce = vi.fn(() => pulled.promise);
    const { autoLoop, callbacks, onTerminalStop, onError } = createLoop({ pullOnce });
    await autoLoop.start();
    const sync = autoLoop.syncNow();
    await vi.waitFor(() => expect(pullOnce).toHaveBeenCalledTimes(1));
    const error = new SyncRealtimeError("sync_paused", "paused for repair");
    callbacks[0]!.onError(error);
    pulled.reject(error);

    expect(await sync).toBe(false);
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(onTerminalStop).toHaveBeenCalledExactlyOnceWith({ type: "sync_paused", error });
  });

  it.each(["resolve", "reject"] as const)("ignores stale push results that %s after restart", async (outcome) => {
    const pushed = deferred<PushPendingMutationsResult>();
    const pushPendingMutations = vi.fn(() => pushed.promise);
    const context = createLoop({ pushPendingMutations });
    const { autoLoop } = context;
    await autoLoop.start();
    const sync = autoLoop.syncNow();
    await vi.waitFor(() => expect(pushPendingMutations).toHaveBeenCalledTimes(1));
    autoLoop.stop();
    await autoLoop.start();

    if (outcome === "resolve") pushed.resolve(createPushResult({ stopReason: "storage_quota_exceeded" }));
    else pushed.reject(new SyncRealtimeError("sync_paused", "old run paused"));
    expect(await sync).toBe(false);

    expect(autoLoop.isActive()).toBe(true);
    expect(context.onError).not.toHaveBeenCalled();
    expect(context.onTerminalStop).not.toHaveBeenCalled();
    expect(context.onStorageQuotaExceeded).not.toHaveBeenCalled();
  });
});
