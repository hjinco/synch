import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestSyncStore } from "../../../../test-support/in-memory-sync-store";
import {
  SyncRealtimeConnectionError,
  type SyncRealtimeCallbacks,
  type SyncRealtimeSession,
} from "../../../remote/realtime-client";
import { SyncAutoLoop } from "../../auto-sync";
import { createPushResult, createRealtimeClient, createToken } from "./helpers";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function createSubscriptionsTest(
  prepareSession?: (session: SyncRealtimeSession, index: number) => void,
) {
  const store = createTestSyncStore();
  const sessions: SyncRealtimeSession[] = [];
  const callbacks: SyncRealtimeCallbacks[] = [];
  const onStorageStatusChange = vi.fn();
  const onPresenceAvailabilityChanged = vi.fn();
  const onPresenceSessionReset = vi.fn();
  const onError = vi.fn();
  const autoLoop = new SyncAutoLoop({
    getApiBaseUrl: () => "http://127.0.0.1:8787",
    getSyncToken: async () => createToken(),
    getSyncStore: () => store,
    pullOnce: vi.fn(async () => {}),
    pushPendingMutations: vi.fn(async () => createPushResult()),
    realtimeClient: createRealtimeClient(
      (nextCallbacks) => callbacks.push(nextCallbacks),
      (session) => {
        session.watchStorageStatus = vi.fn();
        session.unwatchStorageStatus = vi.fn();
        session.watchPresence = vi.fn();
        session.unwatchPresence = vi.fn();
        session.updatePresence = vi.fn();
        session.clearPresence = vi.fn();
        session.close = vi.fn();
        prepareSession?.(session, sessions.length);
        sessions.push(session);
      },
    ),
    onStorageStatusChange,
    onPresenceAvailabilityChanged,
    onPresenceSessionReset,
    onError,
  });
  cleanups.push(async () => {
    autoLoop.stop();
    await store.close();
  });
  return {
    autoLoop,
    sessions,
    callbacks,
    onStorageStatusChange,
    onPresenceAvailabilityChanged,
    onPresenceSessionReset,
    onError,
  };
}

describe("SyncAutoLoop subscriptions", () => {
  it("sends empty presence once until an update or availability reset", async () => {
    const { autoLoop, sessions, callbacks } = createSubscriptionsTest();
    autoLoop.setPresenceWatchEntryIds(["entry-1"]);
    autoLoop.setPresenceWatching(true);
    await autoLoop.start();
    callbacks[0]!.onPresenceAvailabilityChanged(true);

    autoLoop.clearPresence();
    autoLoop.clearPresence();
    expect(sessions[0]!.clearPresence).toHaveBeenCalledTimes(1);

    autoLoop.updatePresence("entry-1", {
      anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 0 },
    });
    autoLoop.clearPresence();
    autoLoop.clearPresence();
    expect(sessions[0]!.clearPresence).toHaveBeenCalledTimes(2);

    callbacks[0]!.onPresenceAvailabilityChanged(false);
    autoLoop.clearPresence();
    expect(sessions[0]!.clearPresence).toHaveBeenCalledTimes(2);
    callbacks[0]!.onPresenceAvailabilityChanged(true);
    autoLoop.clearPresence();
    autoLoop.clearPresence();
    expect(sessions[0]!.clearPresence).toHaveBeenCalledTimes(3);
  });

  it("retries a failed clear instead of remembering it as sent", async () => {
    const clearPresence = vi.fn()
      .mockImplementationOnce(() => { throw new SyncRealtimeConnectionError("closed"); })
      .mockImplementation(() => {});
    const { autoLoop, callbacks, onError } = createSubscriptionsTest((session) => {
      session.clearPresence = clearPresence;
    });
    autoLoop.setPresenceWatching(true);
    await autoLoop.start();
    callbacks[0]!.onPresenceAvailabilityChanged(true);

    autoLoop.clearPresence();
    autoLoop.clearPresence();
    autoLoop.clearPresence();
    expect(clearPresence).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it("restores subscriptions on reconnect and waits for fresh presence availability", async () => {
    const context = createSubscriptionsTest();
    const { autoLoop, sessions, callbacks } = context;
    autoLoop.setStorageStatusWatching(true);
    autoLoop.setPresenceWatchEntryIds(["entry-1"]);
    autoLoop.setPresenceWatching(true);
    await autoLoop.start();
    callbacks[0]!.onPresenceAvailabilityChanged(true);
    autoLoop.clearPresence();
    autoLoop.clearPresence();
    expect(sessions[0]!.clearPresence).toHaveBeenCalledTimes(1);

    callbacks[0]!.onClose({ code: 1006, reason: "connection closed" });

    expect(context.onStorageStatusChange).toHaveBeenLastCalledWith(null);
    expect(context.onPresenceAvailabilityChanged).toHaveBeenLastCalledWith(false);
    expect(context.onPresenceSessionReset).toHaveBeenCalledTimes(1);
    expect(sessions[0]!.close).toHaveBeenCalledTimes(1);

    await autoLoop.resumeConnection();

    expect(sessions).toHaveLength(2);
    expect(sessions[1]!.watchStorageStatus).toHaveBeenCalledTimes(1);
    expect(sessions[1]!.watchPresence).toHaveBeenCalledExactlyOnceWith(["entry-1"]);
    expect(context.onStorageStatusChange).toHaveBeenLastCalledWith({
      storageUsedBytes: 0,
      storageLimitBytes: 100_000_000,
    });
    autoLoop.clearPresence();
    expect(sessions[1]!.clearPresence).not.toHaveBeenCalled();
    callbacks[1]!.onPresenceAvailabilityChanged(true);
    autoLoop.clearPresence();
    autoLoop.clearPresence();
    expect(sessions[1]!.clearPresence).toHaveBeenCalledTimes(1);
  });

  it("rechecks presence support after reconnecting to a compatible server", async () => {
    const { autoLoop, sessions, callbacks } = createSubscriptionsTest((session, index) => {
      session.presenceSupported = index > 0;
    });
    autoLoop.setPresenceWatchEntryIds(["entry-1"]);
    autoLoop.setPresenceWatching(true);
    await autoLoop.start();
    expect(sessions[0]!.watchPresence).not.toHaveBeenCalled();

    callbacks[0]!.onClose({ code: 1006, reason: "connection closed" });
    await autoLoop.resumeConnection();

    expect(sessions[1]!.watchPresence).toHaveBeenCalledExactlyOnceWith(["entry-1"]);
  });

  it("clears the presence watch list when disabled and unsubscribes only once", async () => {
    const { autoLoop, sessions, callbacks, onPresenceSessionReset } = createSubscriptionsTest();
    autoLoop.setPresenceWatchEntryIds(["entry-1"]);
    autoLoop.setPresenceWatching(true);
    await autoLoop.start();
    callbacks[0]!.onPresenceAvailabilityChanged(true);

    autoLoop.setPresenceWatching(false);
    autoLoop.setPresenceWatching(false);
    autoLoop.clearPresence();

    expect(sessions[0]!.unwatchPresence).toHaveBeenCalledTimes(1);
    expect(sessions[0]!.clearPresence).not.toHaveBeenCalled();
    expect(onPresenceSessionReset).toHaveBeenCalledTimes(1);
    autoLoop.setPresenceWatching(true);
    expect(sessions[0]!.watchPresence).toHaveBeenLastCalledWith([]);
  });

  it("normalizes and limits the presence watch list before sending it", async () => {
    const { autoLoop, sessions } = createSubscriptionsTest();
    const entryIds = Array.from({ length: 101 }, (_, index) => `entry-${index}`);
    autoLoop.setPresenceWatchEntryIds([" ", " entry-0 ", ...entryIds]);
    autoLoop.setPresenceWatching(true);
    await autoLoop.start();

    expect(sessions[0]!.watchPresence).toHaveBeenCalledExactlyOnceWith(entryIds.slice(0, 100));
  });

  it("allows a failed watch to be retried without reporting a connection error", async () => {
    const watchPresence = vi.fn()
      .mockImplementationOnce(() => { throw new SyncRealtimeConnectionError("closed"); })
      .mockImplementation(() => {});
    const { autoLoop, onError } = createSubscriptionsTest((session) => {
      session.watchPresence = watchPresence;
    });
    autoLoop.setPresenceWatching(true);
    await autoLoop.start();

    autoLoop.setPresenceWatching(true);
    autoLoop.setPresenceWatching(true);

    expect(watchPresence).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports subscription errors through the loop error handler", async () => {
    const error = new Error("watch failed");
    const { autoLoop, onError } = createSubscriptionsTest((session) => {
      session.watchPresence = vi.fn(() => { throw error; });
    });
    autoLoop.setPresenceWatching(true);
    await autoLoop.start();

    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
  });

  it("only reports policy storage changes while storage watching is enabled", async () => {
    const { autoLoop, sessions, callbacks, onStorageStatusChange } = createSubscriptionsTest();
    await autoLoop.start();
    const policy = { storageLimitBytes: 200, maxFileSizeBytes: 100 };
    const status = { storageUsedBytes: 50, storageLimitBytes: 200 };
    callbacks[0]!.onPolicyUpdated(policy, status);
    expect(onStorageStatusChange).not.toHaveBeenCalled();

    autoLoop.setStorageStatusWatching(true);
    autoLoop.setStorageStatusWatching(true);
    callbacks[0]!.onPolicyUpdated(policy, status);
    expect(sessions[0]!.watchStorageStatus).toHaveBeenCalledTimes(1);
    expect(onStorageStatusChange).toHaveBeenLastCalledWith(status);

    autoLoop.setStorageStatusWatching(false);
    autoLoop.setStorageStatusWatching(false);
    callbacks[0]!.onPolicyUpdated(policy, status);
    expect(sessions[0]!.unwatchStorageStatus).toHaveBeenCalledTimes(1);
    expect(onStorageStatusChange).toHaveBeenLastCalledWith(null);
  });
});
