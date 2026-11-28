import { describe, expect, it, vi } from "vitest";

import { createTestSyncStore } from "../../../../test-support/in-memory-sync-store";
import { SyncAutoLoop } from "../../auto-sync";
import type { SyncRealtimeCallbacks } from "../../../remote/realtime-client";
import {
  createPushResult,
  createRealtimeClient,
  createToken,
} from "./helpers";

describe("SyncAutoLoop pull-only", () => {
  it.each(["success", "failure"])("excludes other sessions until a pull-only %s completes", async (outcome) => {
    const store = createTestSyncStore();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const pullOnce = vi.fn(async () => {
      await pending;
      if (outcome === "failure") throw new Error("pull failed");
    });
    const openSession = vi.fn(createRealtimeClient().openSession);
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations: vi.fn(async () => createPushResult()),
      pullOnce,
      realtimeClient: { openSession },
    });
    const pull = autoLoop.pullOnlyOnce();
    const result = pull.catch((error: unknown) => error);
    try {
      await vi.waitFor(() => expect(pullOnce).toHaveBeenCalledTimes(1));
      expect(autoLoop.hasInFlightWork()).toBe(true);
      await expect(autoLoop.start()).rejects.toThrow("pull-only session");
      await expect(autoLoop.withRealtimeSession(async () => {})).rejects.toThrow("pull-only session");
      await expect(autoLoop.pullOnlyOnce()).rejects.toThrow("pull-only session");
      expect(openSession).toHaveBeenCalledTimes(1);
      finish();
      if (outcome === "failure") expect(await result).toEqual(new Error("pull failed"));
      else expect(await result).toBeUndefined();
      expect(autoLoop.hasInFlightWork()).toBe(false);
      expect(await autoLoop.start()).toBe(true);
      expect(openSession).toHaveBeenCalledTimes(2);
    } finally {
      finish();
      await result;
      autoLoop.stop();
      await store.close();
    }
  });

  it("pulls once without scheduling pending local mutations for push", async () => {
    const store = createTestSyncStore();
    await store.setCursor(4);
    const pullOnce = vi.fn(async () => {});
    const pushPendingMutations = vi.fn(async () => createPushResult());
    let sessionClosed = false;
    const realtimeClient = createRealtimeClient(
      undefined,
      (session) => {
        session.close = () => {
          sessionClosed = true;
        };
      },
      7,
    );
    const openSession = vi.fn(realtimeClient.openSession);
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations,
      pullOnce,
      realtimeClient: { openSession },
    });

    await autoLoop.pullOnlyOnce();

    expect(openSession).toHaveBeenCalledWith(
      "http://127.0.0.1:8787",
      expect.objectContaining({ vaultId: "vault-1" }),
      4,
      expect.any(Object),
    );
    expect(pullOnce).toHaveBeenCalledTimes(1);
    expect(pushPendingMutations).not.toHaveBeenCalled();
    expect(sessionClosed).toBe(true);
    await store.close();
  });

  it("refuses to run alongside the auto-sync loop", async () => {
    const store = createTestSyncStore();
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations: vi.fn(async () => createPushResult()),
      pullOnce: vi.fn(async () => {}),
      realtimeClient: createRealtimeClient(),
    });

    await autoLoop.start();
    await expect(autoLoop.pullOnlyOnce()).rejects.toThrow(
      "requires the auto-sync loop and all in-flight sync work to be stopped",
    );
    autoLoop.stop();
    await store.close();
  });

  it.each([null, "file_too_large", "incompatible_path"] as const)("refuses to pull with a pending local change (blocked reason %s)", async (blockedReason) => {
    const store = createTestSyncStore();
    await store.markEntryDirty({
      mutationId: "mutation-1",
      entryId: "entry-1",
      op: "delete",
      baseRevision: 0,
      blobId: null,
      hash: null,
      status: blockedReason ? "blocked" : "pending",
      blockedReason,
      encryptedMetadata: "encrypted-metadata",
      createdAt: 1,
    });
    const pullOnce = vi.fn(async () => {});
    const openSession = vi.fn(createRealtimeClient().openSession);
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations: vi.fn(async () => createPushResult()),
      pullOnce,
      realtimeClient: { openSession },
    });

    await expect(autoLoop.pullOnlyOnce()).rejects.toThrow(
      "no pending local changes",
    );
    expect(openSession).not.toHaveBeenCalled();
    expect(pullOnce).not.toHaveBeenCalled();
    await store.close();
  });

  it("explains how to rebuild state when the local cursor is ahead", async () => {
    const store = createTestSyncStore();
    await store.setCursor(8);
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations: vi.fn(async () => createPushResult()),
      pullOnce: vi.fn(async () => {}),
      realtimeClient: createRealtimeClient(undefined, undefined, 7),
    });

    await expect(autoLoop.pullOnlyOnce()).rejects.toThrow(
      "Move .synch/sync.sqlite aside",
    );
    await store.close();
  });

  it.each(["opening", "pulling"])("propagates session errors while %s and still closes the session", async (phase) => {
    const store = createTestSyncStore();
    let sessionClosed = false;
    const sessionError = new Error("session failed");
    let callbacks: SyncRealtimeCallbacks | undefined;
    const pullOnce = vi.fn(async () => {
      callbacks?.onError(sessionError);
      callbacks?.onError(new Error("later failure"));
    });
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations: vi.fn(async () => createPushResult()),
      pullOnce,
      realtimeClient: createRealtimeClient(
        (openedCallbacks) => {
          callbacks = openedCallbacks;
          if (phase === "opening") callbacks.onError(sessionError);
        },
        (session) => {
          session.close = () => {
            sessionClosed = true;
          };
        },
      ),
    });

    await expect(autoLoop.pullOnlyOnce()).rejects.toBe(sessionError);
    expect(pullOnce).toHaveBeenCalledTimes(phase === "pulling" ? 1 : 0);
    expect(sessionClosed).toBe(true);
    await store.close();
  });
});
