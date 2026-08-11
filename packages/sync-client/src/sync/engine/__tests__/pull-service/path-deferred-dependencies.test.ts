import { describe, expect, it } from "vitest";

import { SyncPullService } from "../../pull-service";
import { createTestSyncStore } from "../../../../test-support/in-memory-sync-store";
import {
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

describe("SyncPullService deferred path dependencies", () => {
  it("defers cross-window path swaps until both sides are available", async () => {
    const store = createTestSyncStore();
    const adapter = createVaultAdapter({
      "Folder/a.md": "old a",
      "Folder/b.md": "old b",
    });
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
          cursor: 2,
          hasMore: true,
          commits: [
            createCommit({
              cursor: 1,
              entryId: "entry-a",
              revision: 2,
              blobId: "blob-a-new",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-a",
                revision: 2,
                blobId: "blob-a-new",
                path: "Folder/b.md",
                hash: await hashText("new a"),
              }),
            }),
            createCommit({
              cursor: 2,
              entryId: "entry-filler",
              revision: 1,
              blobId: "blob-filler",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-filler",
                revision: 1,
                blobId: "blob-filler",
                path: "Folder/filler.md",
                hash: await hashText("filler"),
              }),
            }),
          ],
        },
        {
          cursor: 3,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 3,
              entryId: "entry-b",
              revision: 2,
              blobId: "blob-b-new",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-b",
                revision: 2,
                blobId: "blob-b-new",
                path: "Folder/a.md",
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
        "blob-filler": await encryptTestBlob("blob-filler", new TextEncoder().encode("filler")),
      },
    });
    const conflicts: Array<{ entryId: string; conflictPath: string | null }> = [];

    const service = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      vaultAdapter: adapter,
      pullClient: client,
      applyWindowSize: 2,
      onProgress: ignoreProgress,
      onConflict(event) {
        conflicts.push({ entryId: event.entryId, conflictPath: event.conflictPath });
      },
    });

    await expect(service.pullOnce(session)).resolves.toMatchObject({
      cursor: 3,
      entriesApplied: 3,
      filesWritten: 3,
      filesDeleted: 2,
      conflictsCreated: 0,
    });
    expect(adapter.text("Folder/a.md")).toBe("new b");
    expect(adapter.text("Folder/b.md")).toBe("new a");
    expect(adapter.text("Folder/filler.md")).toBe("filler");
    expect(conflicts).toEqual([]);

    await store.close();
  });

  it("defers entries that target a deferred owner's current path", async () => {
    const store = createTestSyncStore();
    const adapter = createVaultAdapter({
      "Folder/a.md": "old a",
      "Folder/b.md": "old b",
      "Folder/c.md": "old c",
    });
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
    await store.upsertEntry({
      entryId: "entry-c",
      path: "Folder/c.md",
      revision: 1,
      blobId: "blob-c-old",
      hash: "hash-c",
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: null,
    });

    const session = createRealtimeSession({
      pages: [
        {
          cursor: 2,
          hasMore: true,
          commits: [
            createCommit({
              cursor: 1,
              entryId: "entry-a",
              revision: 2,
              blobId: "blob-a-new",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-a",
                revision: 2,
                blobId: "blob-a-new",
                path: "Folder/b.md",
                hash: await hashText("new a"),
              }),
            }),
            createCommit({
              cursor: 2,
              entryId: "entry-c",
              revision: 2,
              blobId: "blob-c-new",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-c",
                revision: 2,
                blobId: "blob-c-new",
                path: "Folder/a.md",
                hash: await hashText("new c"),
              }),
            }),
          ],
        },
        {
          cursor: 3,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 3,
              entryId: "entry-b",
              revision: 2,
              blobId: "blob-b-new",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-b",
                revision: 2,
                blobId: "blob-b-new",
                path: "Folder/d.md",
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
        "blob-c-new": await encryptTestBlob("blob-c-new", new TextEncoder().encode("new c")),
      },
    });
    const conflicts: Array<{ entryId: string; conflictPath: string | null }> = [];

    const service = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      vaultAdapter: adapter,
      pullClient: client,
      applyWindowSize: 2,
      onProgress: ignoreProgress,
      onConflict(event) {
        conflicts.push({ entryId: event.entryId, conflictPath: event.conflictPath });
      },
    });

    await expect(service.pullOnce(session)).resolves.toMatchObject({
      cursor: 3,
      entriesApplied: 3,
      filesWritten: 3,
      filesDeleted: 2,
      conflictsCreated: 0,
    });
    expect(adapter.text("Folder/a.md")).toBe("new c");
    expect(adapter.text("Folder/b.md")).toBe("new a");
    expect(adapter.text("Folder/d.md")).toBe("new b");
    expect(conflicts).toEqual([]);

    await store.close();
  });
});
