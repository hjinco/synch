import { describe, expect, it } from "vitest";

import { SyncPullService } from "../../pull-service";
import { createTestSyncStore } from "../../../../test-support/in-memory-sync-store";
import {
  arrangePendingUpsertWithCachedBase,
  createCommit,
  createPullClient,
  createRealtimeSession,
  createToken,
  createVaultAdapter,
  encryptRemoteMetadata,
  encryptTestBlob,
  hashText,
  ignoreProgress,
  TEST_VAULT_KEY,
} from "./helpers";

describe("SyncPullService failure rollback: apply", () => {
  it("keeps the pending edit when a clean text merge write fails", async () => {
    const store = createTestSyncStore();
    const path = "Folder/note.md";
    const baseBody = "Title\n\noriginal line\n";
    const localBody = "Title\n\nlocal line\n";
    const remoteBody = "Remote title\n\noriginal line\n";
    const baseHash = await hashText(baseBody);
    const localHash = await hashText(localBody);
    const remoteHash = await hashText(remoteBody);
    const adapter = createVaultAdapter({
      [path]: localBody,
    });
    const failingAdapter = {
      ...adapter,
      async writeText(writePath: string, content: string): Promise<void> {
        if (writePath === path) {
          throw new Error("simulated merge write failure");
        }
        await adapter.writeText(writePath, content);
      },
    };

    await arrangePendingUpsertWithCachedBase(store, {
      entryId: "entry-note",
      path,
      baseRevision: 2,
      baseBlobId: "blob-base",
      baseHash,
      baseBytes: new TextEncoder().encode(baseBody),
      localBlobId: "blob-local",
      localHash,
      createdAt: 3,
      mutationId: "mutation-note",
    });

    const session = createRealtimeSession({
      pages: [
        {
          cursor: 3,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 3,
              entryId: "entry-note",
              revision: 3,
              blobId: "blob-remote",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-note",
                revision: 3,
                blobId: "blob-remote",
                path,
                hash: remoteHash,
              }),
            }),
          ],
        },
      ],
    });
    const service = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      vaultAdapter: failingAdapter,
      pullClient: createPullClient({
        blobs: {
          "blob-remote": await encryptTestBlob(
            "blob-remote",
            new TextEncoder().encode(remoteBody),
          ),
        },
      }),
      onProgress: ignoreProgress,
    });

    await expect(service.pullOnce(session)).rejects.toThrow("simulated merge write failure");
    expect(adapter.text(path)).toBe(localBody);
    expect(await store.getRemoteStateById("entry-note")).toMatchObject({
      path,
      revision: 2,
      blobId: "blob-base",
    });
    expect(await store.getDirtyEntryMutation("entry-note")).toMatchObject({
      mutationId: "mutation-note",
      entryId: "entry-note",
      baseRevision: 2,
      blobId: "blob-local",
      hash: localHash,
    });

    await store.close();
  });

  it("keeps the pending edit when rebasing the merged dirty mutation fails", async () => {
    const store = createTestSyncStore();
    const path = "Folder/note.md";
    const baseBody = "Title\n\noriginal line\n";
    const localBody = "Title\n\nlocal line\n";
    const remoteBody = "Remote title\n\noriginal line\n";
    const mergedBody = "Remote title\n\nlocal line\n";
    const baseHash = await hashText(baseBody);
    const localHash = await hashText(localBody);
    const remoteHash = await hashText(remoteBody);
    const adapter = createVaultAdapter({
      [path]: localBody,
    });

    await arrangePendingUpsertWithCachedBase(store, {
      entryId: "entry-note",
      path,
      baseRevision: 2,
      baseBlobId: "blob-base",
      baseHash,
      baseBytes: new TextEncoder().encode(baseBody),
      localBlobId: "blob-local",
      localHash,
      createdAt: 3,
      mutationId: "mutation-note",
    });

    const failingStore = new Proxy(store, {
      get(target, property, receiver) {
        if (property === "replaceDirtyEntry") {
          return async () => {
            throw new Error("simulated dirty rebase failure");
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const session = createRealtimeSession({
      pages: [
        {
          cursor: 3,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 3,
              entryId: "entry-note",
              revision: 3,
              blobId: "blob-remote",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-note",
                revision: 3,
                blobId: "blob-remote",
                path,
                hash: remoteHash,
              }),
            }),
          ],
        },
      ],
    });
    const service = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => failingStore,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      vaultAdapter: adapter,
      pullClient: createPullClient({
        blobs: {
          "blob-remote": await encryptTestBlob(
            "blob-remote",
            new TextEncoder().encode(remoteBody),
          ),
        },
      }),
      onProgress: ignoreProgress,
    });

    await expect(service.pullOnce(session)).rejects.toThrow("simulated dirty rebase failure");
    expect(adapter.text(path)).toBe(mergedBody);
    expect(await store.getRemoteStateById("entry-note")).toMatchObject({
      path,
      revision: 2,
      blobId: "blob-base",
    });
    expect(await store.getDirtyEntryMutation("entry-note")).toMatchObject({
      mutationId: "mutation-note",
      entryId: "entry-note",
      baseRevision: 2,
      blobId: "blob-local",
      hash: localHash,
    });

    await store.close();
  });

  it("does not advance entry rows when a later path batch write fails", async () => {
    const store = createTestSyncStore();
    const adapter = createVaultAdapter({
      "Folder/a.md": "old a",
      "Folder/b.md": "old b",
    });
    const failingAdapter = {
      ...adapter,
      async writeText(path: string, content: string): Promise<void> {
        if (path === "Folder/b.md") {
          throw new Error("simulated vault write failure");
        }
        await adapter.writeText(path, content);
      },
    };
    await store.upsertEntry({
      entryId: "entry-a",
      path: "Folder/a.md",
      revision: 1,
      blobId: "blob-a-old",
      hash: "hash-a",
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: null,
    });
    await store.upsertEntry({
      entryId: "entry-b",
      path: "Folder/b.md",
      revision: 1,
      blobId: "blob-b-old",
      hash: "hash-b",
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: null,
    });

    const session = createRealtimeSession({
      pages: [
        {
          cursor: 3,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 2,
              entryId: "entry-a",
              revision: 2,
              blobId: "blob-a-new",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-a",
                revision: 2,
                blobId: "blob-a-new",
                path: "Folder/a.md",
                hash: await hashText("new a"),
              }),
            }),
            createCommit({
              cursor: 3,
              entryId: "entry-b",
              revision: 2,
              blobId: "blob-b-new",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-b",
                revision: 2,
                blobId: "blob-b-new",
                path: "Folder/b.md",
                hash: await hashText("new b"),
              }),
            }),
          ],
        },
      ],
    });
    const client = createPullClient({
      blobs: {
        "blob-a-new": await encryptTestBlob("blob-a-new", new TextEncoder().encode("new a")),
        "blob-b-new": await encryptTestBlob("blob-b-new", new TextEncoder().encode("new b")),
      },
    });
    const service = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      vaultAdapter: failingAdapter,
      pullClient: client,
      onProgress: ignoreProgress,
    });

    await expect(service.pullOnce(session)).rejects.toThrow("simulated vault write failure");
    expect(adapter.text("Folder/a.md")).toBe("new a");
    expect(adapter.text("Folder/b.md")).toBe("old b");
    expect(await store.getEntryById("entry-a")).toMatchObject({
      path: "Folder/a.md",
      revision: 1,
      blobId: "blob-a-old",
    });
    expect(await store.getEntryById("entry-b")).toMatchObject({
      path: "Folder/b.md",
      revision: 1,
      blobId: "blob-b-old",
    });
    expect(await store.getCursor()).toBe(0);

    await store.close();
  });
});
