import { describe, expect, it, vi } from "vitest";

import { createTestSyncStore } from "../../../../test-support/in-memory-sync-store";
import { SyncAutoLoop } from "../../auto-sync";
import {
  createPushResult,
  createRealtimeClient,
  createToken,
} from "./helpers";

describe("SyncAutoLoop pull-only", () => {
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

  it("propagates asynchronous session errors and still closes the session", async () => {
    const store = createTestSyncStore();
    let sessionClosed = false;
    const sessionError = new Error("session failed");
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      pushPendingMutations: vi.fn(async () => createPushResult()),
      pullOnce: vi.fn(async () => {}),
      realtimeClient: createRealtimeClient(
        (callbacks) => callbacks.onError(sessionError),
        (session) => {
          session.close = () => {
            sessionClosed = true;
          };
        },
      ),
    });

    await expect(autoLoop.pullOnlyOnce()).rejects.toThrow("session failed");
    expect(sessionClosed).toBe(true);
    await store.close();
  });
});
