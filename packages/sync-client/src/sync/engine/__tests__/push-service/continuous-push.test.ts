import { describe, expect, it, vi } from "vitest";

import { createTestContentRuntime } from "../../../../test-support/content-runtime";
import { createTestSyncStore } from "../../../../test-support/in-memory-sync-store";
import { encodeUtf8, hashBytes } from "../../../core/content";
import { SyncAutoLoop } from "../../auto-sync";
import { PushNoProgressError, SyncPushService } from "../../push-service";
import { createRealtimeClient } from "../auto-sync/helpers";
import {
  createPushSession, createToken, encryptMutationMetadata,
  ignoreProgress, TEST_VAULT_KEY,
} from "./helpers";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(count: number) {
  const store = createTestSyncStore();
  const body = encodeUtf8("body");
  const hash = await hashBytes(body);
  for (let index = 0; index < count; index++) {
    await store.markEntryDirty({
      mutationId: `mutation-${index}`, entryId: `entry-${index}`,
      op: "upsert", baseRevision: 0, blobId: `blob-${index}`, hash,
      encryptedMetadata: await encryptMutationMetadata({
        entryId: `entry-${index}`, baseRevision: 0, op: "upsert",
        blobId: `blob-${index}`, path: `file-${index}.md`, hash,
      }),
      createdAt: index,
    });
  }
  let cursor = 0;
  const session = createPushSession(async (mutation) => ({
    cursor: ++cursor, entryId: mutation.entryId, revision: mutation.baseRevision + 1,
  }));
  const deps = {
    contentRuntime: createTestContentRuntime(),
    getSyncToken: async () => createToken(),
    getSyncStore: () => store,
    getRemoteVaultKey: () => TEST_VAULT_KEY,
    fileReader: { async readBytes() { return body; } },
  };
  return { store, session, deps };
}

describe("continuous push", () => {
  it("replenishes beyond the first 100 entries before a slow upload finishes", async () => {
    const { store, session, deps } = await fixture(125);
    const slow = gate();
    let active = 0;
    let maxActive = 0;
    let owned = 0;
    let maxOwned = 0;
    const completed: string[] = [];
    const service = new SyncPushService({
      ...deps,
      blobClient: {
        async uploadBlob(_vault, id) {
          active++;
          maxActive = Math.max(maxActive, active);
          try { if (id === "blob-0") await slow.promise; }
          finally { active--; }
        },
      },
      onFileSyncStarted() { owned++; maxOwned = Math.max(maxOwned, owned); },
      onFileSyncCompleted({ path }) { owned--; completed.push(path); },
    });
    const push = service.pushPendingMutations(session);
    try {
      await vi.waitFor(() => expect(completed).toHaveLength(124));
      expect(completed).not.toContain("file-0.md");
      expect(maxActive).toBeLessThanOrEqual(12);
      expect(maxOwned).toBeLessThanOrEqual(100);
    } finally { slow.resolve(); }
    expect(await push).toMatchObject({ mutationsPushed: 125, hasMore: false });
    expect(await store.getCursor()).toBe(125);
    await store.close();
  });

  it.each(["pull", "stop"] as const)("joins started work before %s and preserves the remaining queue", async (action) => {
    const { store, session, deps } = await fixture(125);
    const uploads = gate();
    let started = 0;
    let completed = 0;
    let pulled = false;
    const service = new SyncPushService({
      ...deps,
      blobClient: {
        async uploadBlob() {
          started++;
          await uploads.promise;
        },
      },
      onFileSyncCompleted() { completed++; },
    });
    const loop = new SyncAutoLoop({
      ...deps,
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      realtimeClient: createRealtimeClient(undefined, (next) => {
        next.commitMutations = session.commitMutations;
      }),
      pushPendingMutations: (next, shouldYield) =>
        service.pushPendingMutations(next, ignoreProgress, shouldYield),
      async pullOnce() {
        expect(started).toBe(12);
        expect(completed).toBe(12);
        expect(await store.getCursor()).toBe(12);
        expect(await store.listDirtyEntries()).toHaveLength(113);
        pulled = true;
      },
    });
    await loop.start();
    loop.notifyLocalChange();
    loop.flushDebouncedPush();
    const drain = loop.waitForInFlightDrain();
    try {
      await vi.waitFor(() => expect(started).toBe(12));
      if (action === "pull") loop.requestPull(13);
      else loop.stop();
      expect(pulled).toBe(false);
      uploads.resolve();
      await drain;
      expect(pulled).toBe(action === "pull");
      expect(completed).toBe(action === "pull" ? 125 : 12);
      expect(await store.listDirtyEntries()).toHaveLength(action === "pull" ? 0 : 113);
    } finally {
      uploads.resolve();
      loop.stop();
      await drain;
      await store.close();
    }
  });

  it("yields without starting files when pull is already pending", async () => {
    const { store, session, deps } = await fixture(1);
    const uploadBlob = vi.fn(async () => {});
    const service = new SyncPushService({ ...deps, blobClient: { uploadBlob } });
    expect(await service.pushPendingMutations(session, ignoreProgress, () => true))
      .toMatchObject({ mutationsPushed: 0, hasMore: true });
    expect(uploadBlob).not.toHaveBeenCalled();
    await store.close();
  });

  it("does not start a store selection if pull arrives during its read", async () => {
    const { store, session, deps } = await fixture(1);
    const selection = gate();
    let reading = false;
    let yielding = false;
    const list = store.listDirtyEntries.bind(store);
    vi.spyOn(store, "listDirtyEntries").mockImplementationOnce(async (...args) => {
      reading = true;
      await selection.promise;
      return list(...args);
    });
    const uploadBlob = vi.fn(async () => {});
    const service = new SyncPushService({ ...deps, blobClient: { uploadBlob } });
    const push = service.pushPendingMutations(session, ignoreProgress, () => yielding);
    try {
      await vi.waitFor(() => expect(reading).toBe(true));
      yielding = true;
    } finally { selection.resolve(); }
    expect(await push).toMatchObject({ mutationsPushed: 0, hasMore: true });
    expect(uploadBlob).not.toHaveBeenCalled();
    await store.close();
  });

  it("returns a retryable failure if a changing file repeatedly prevents progress", async () => {
    const { store, session, deps } = await fixture(1);
    let reads = 0;
    const service = new SyncPushService({
      ...deps,
      fileReader: { async readBytes() { return encodeUtf8(`edit-${++reads}`); } },
      blobClient: { async uploadBlob() { throw new Error("changed content must be requeued"); } },
    });
    await expect(service.pushPendingMutations(session)).rejects.toBeInstanceOf(PushNoProgressError);
    expect(reads).toBeLessThan(10);
    expect(await store.listDirtyEntries()).toHaveLength(1);
    expect(await store.getCursor()).toBe(0);
    await store.close();
  });
});
