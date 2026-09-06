import { describe, expect, it, vi } from "vitest";

import { createTestSyncStore } from "../../../../test-support/in-memory-sync-store";
import { SyncAutoLoop } from "../../auto-sync";
import {
  createPushResult,
  createRealtimeClient,
  createToken,
} from "./helpers";

describe("SyncAutoLoop presence", () => {
  it("watches presence after the realtime session is live", async () => {
    const store = createTestSyncStore();
    const watchPresence = vi.fn();
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pullOnce: vi.fn(async () => {}),
      pushPendingMutations: vi.fn(async () => createPushResult()),
      realtimeClient: createRealtimeClient(undefined, (session) => {
        session.watchPresence = watchPresence;
      }),
    });

    autoLoop.setPresenceWatchEntryIds(["entry-1"]);
    autoLoop.setPresenceWatching(true);
    await autoLoop.start();

    expect(watchPresence).toHaveBeenCalledWith(["entry-1"]);
    autoLoop.stop();
    await store.close();
  });

  it("does not send presence when the server does not advertise support", async () => {
    const store = createTestSyncStore();
    const watchPresence = vi.fn();
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pullOnce: vi.fn(async () => {}),
      pushPendingMutations: vi.fn(async () => createPushResult()),
      realtimeClient: createRealtimeClient(undefined, (session) => {
        session.presenceSupported = false;
        session.watchPresence = watchPresence;
      }),
    });

    autoLoop.setPresenceWatchEntryIds(["entry-1"]);
    autoLoop.setPresenceWatching(true);
    await autoLoop.start();

    expect(watchPresence).not.toHaveBeenCalled();
    autoLoop.stop();
    await store.close();
  });

  it("does not resend a watch list when only its order changes", async () => {
    const store = createTestSyncStore();
    const watchPresence = vi.fn();
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pullOnce: vi.fn(async () => {}),
      pushPendingMutations: vi.fn(async () => createPushResult()),
      realtimeClient: createRealtimeClient(undefined, (session) => {
        session.watchPresence = watchPresence;
      }),
    });

    autoLoop.setPresenceWatchEntryIds(["entry-1", "entry-2"]);
    autoLoop.setPresenceWatching(true);
    await autoLoop.start();
    autoLoop.setPresenceWatchEntryIds(["entry-2", "entry-1"]);

    expect(watchPresence).toHaveBeenCalledTimes(1);
    autoLoop.stop();
    await store.close();
  });

  it("resets presence when the auto-sync loop stops", async () => {
    const store = createTestSyncStore();
    let emitAvailability: ((enabled: boolean) => void) | undefined;
    const onPresenceAvailabilityChanged = vi.fn();
    const onPresenceSessionReset = vi.fn();
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pullOnce: vi.fn(async () => {}),
      pushPendingMutations: vi.fn(async () => createPushResult()),
      realtimeClient: createRealtimeClient((callbacks) => {
        emitAvailability = (enabled) => {
          callbacks.onPresenceAvailabilityChanged(enabled);
        };
      }),
      onPresenceAvailabilityChanged,
      onPresenceSessionReset,
    });

    autoLoop.setPresenceWatching(true);
    await autoLoop.start();
    emitAvailability?.(true);
    autoLoop.stop();

    expect(onPresenceAvailabilityChanged).toHaveBeenLastCalledWith(false);
    expect(onPresenceSessionReset).toHaveBeenCalledTimes(1);
    await store.close();
  });
});
