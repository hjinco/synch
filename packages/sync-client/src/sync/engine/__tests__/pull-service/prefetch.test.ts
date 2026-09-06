import { createTestContentRuntime } from "../../../../test-support/content-runtime";
import { describe, expect, it, vi } from "vitest";
import { createTestSyncStore } from "../../../../test-support/in-memory-sync-store";
import { SyncPullService } from "../../pull-service";
import {
  createCommit, createBlobClient, createRealtimeSession, createToken,
  createVaultAdapter, encryptRemoteMetadata, encryptTestBlob, hashText,
  TEST_VAULT_KEY,
} from "./helpers";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function setup() {
  const store = createTestSyncStore();
  const adapter = createVaultAdapter();
  const commits = await Promise.all([1, 2, 3].map(async (id) => createCommit({
    cursor: id,
    entryId: `entry-${id}`,
    blobId: `blob-${id}`,
    encryptedMetadata: await encryptRemoteMetadata({
      entryId: `entry-${id}`, revision: 1, blobId: `blob-${id}`,
      path: `note-${id}.md`, hash: await hashText(`body-${id}`),
    }),
  })));
  const session = createRealtimeSession({
    pages: commits.map((commit, index) => ({
      cursor: 3, hasMore: index < 2, commits: [commit],
    })),
  });
  const client = createBlobClient({ blobs: Object.fromEntries(await Promise.all(
    [1, 2, 3].map(async (id) => [
      `blob-${id}`, await encryptTestBlob(`blob-${id}`, new TextEncoder().encode(`body-${id}`)),
    ]),
  )) });
  const service = new SyncPullService({
    contentRuntime: createTestContentRuntime(),
    getSyncToken: async () => createToken(),
    getSyncStore: () => store,
    getRemoteVaultKey: () => TEST_VAULT_KEY,
    vaultAdapter: adapter, blobClient: client, applyWindowSize: 1,
  });
  return { store, adapter, session, client, service };
}

describe("SyncPullService page prefetch", () => {
  it("fetches one page ahead during downloads and preserves pagination and checkpoint order", async () => {
    const { store, adapter, session, client, service } = await setup();
    const release = gate();
    const list = vi.spyOn(session, "listEntryStates");
    const download = client.downloadBlob.bind(client);
    const downloads = vi.spyOn(client, "downloadBlob").mockImplementation(async (...args) => {
      if (args[1] === "blob-1") await release.promise;
      return await download(...args);
    });
    const pulling = service.pullOnce(session);
    try {
      await vi.waitFor(() => expect(downloads).toHaveBeenCalledTimes(1));
      expect(list).toHaveBeenCalledTimes(2);
      expect(list.mock.calls[1][0]).toMatchObject({
        sinceCursor: 0, targetCursor: 3,
        after: { updatedSeq: 1, entryId: "entry-1" },
      });
      expect(await store.getCursor()).toBe(0);
      expect(await adapter.exists("note-2.md")).toBe(false);
    } finally {
      release.resolve();
    }
    await expect(pulling).resolves.toMatchObject({ cursor: 3, filesWritten: 3 });
    expect(list).toHaveBeenCalledTimes(3);
    expect(list.mock.calls[2][0]).toMatchObject({
      sinceCursor: 0, targetCursor: 3,
      after: { updatedSeq: 2, entryId: "entry-2" },
    });
    expect(adapter.text("note-3.md")).toBe("body-3");
    await store.close();
  });

  it.each(["request", "metadata"])("keeps the applied checkpoint when prefetched %s fails", async (failure) => {
    const { store, adapter, session, client, service } = await setup();
    const release = gate();
    const list = session.listEntryStates.bind(session);
    const failureObserved = gate();
    const error = new Error("injected page failure");
    vi.spyOn(session, "listEntryStates").mockImplementation(async (request) => {
      const page = await list(request);
      if (request.after) {
        failureObserved.resolve();
        if (failure === "request") throw error;
        page.entries[0].encryptedMetadata = "invalid";
      }
      return page;
    });
    const download = client.downloadBlob.bind(client);
    vi.spyOn(client, "downloadBlob").mockImplementation(async (...args) => {
      await release.promise;
      return await download(...args);
    });
    const outcome = service.pullOnce(session).then(
      () => ({ error: null }), (error: unknown) => ({ error }),
    );
    await failureObserved.promise;
    // Give the prefetch time to reject while the current download is blocked.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(await store.getCursor()).toBe(0);
    release.resolve();
    const result = await outcome;
    if (failure === "request") expect(result.error).toBe(error);
    else expect(result.error).toBeInstanceOf(Error);
    expect(await store.getCursor()).toBe(1);
    expect(adapter.text("note-1.md")).toBe("body-1");
    expect(await adapter.exists("note-2.md")).toBe(false);
    await store.close();
  });

  it("drains an outstanding prefetch after apply fails and preserves the apply error", async () => {
    const { store, session, client, service } = await setup();
    const release = gate();
    const list = session.listEntryStates.bind(session);
    const calls = vi.spyOn(session, "listEntryStates").mockImplementation(async (request) => {
      if (request.after) {
        await release.promise;
        throw new Error("injected prefetch failure");
      }
      return await list(request);
    });
    const error = new Error("injected download failure");
    const failed = gate();
    vi.spyOn(client, "downloadBlob").mockImplementation(async () => {
      failed.resolve();
      throw error;
    });
    let settled = false;
    const outcome = service.pullOnce(session).then(
      () => ({ error: null }), (error: unknown) => ({ error }),
    ).finally(() => { settled = true; });
    try {
      await failed.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(calls).toHaveBeenCalledTimes(2);
      expect(settled).toBe(false);
    } finally {
      release.resolve();
    }
    expect((await outcome).error).toBe(error);
    expect(await store.getCursor()).toBe(0);
    expect(calls).toHaveBeenCalledTimes(2);
    await store.close();
  });
});
