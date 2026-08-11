import { describe, expect, it } from "vitest";

import { SyncPullService } from "../../pull-service";
import { createTestSyncStore } from "../../../../test-support/in-memory-sync-store";
import {
  createCommit,
  createPullClient,
  createRealtimeSession,
  createToken,
  createVaultAdapter,
  encryptPendingMetadata,
  encryptRemoteMetadata,
  encryptTestBlob,
  hashText,
  ignoreProgress,
  TEST_VAULT_KEY,
  type PullConflictSummary,
} from "./helpers";

const conflictTimestamp = () => new Date(2026, 3, 22, 10, 11, 12).getTime();

describe("SyncPullService failure rollback: preparation", () => {
  it("leaves local state untouched when blob preparation fails", async () => {
    const store = createTestSyncStore();
    const adapter = createVaultAdapter({
      "Folder/note.md": "local body",
    });
    const conflicts: PullConflictSummary[] = [];
    await store.upsertEntry({
      entryId: "entry-note",
      path: "Folder/note.md",
      revision: 2,
      blobId: "blob-old",
      hash: "local-hash",
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: null,
    });
    await store.markEntryDirty({
      mutationId: "mutation-note",
      entryId: "entry-note",
      op: "upsert",
      baseRevision: 2,
      blobId: "blob-local-pending",
      hash: "local-hash",
      encryptedMetadata: await encryptPendingMetadata({
        entryId: "entry-note",
        baseRevision: 2,
        op: "upsert",
        blobId: "blob-local-pending",
        path: "Folder/note.md",
        hash: "local-hash",
      }),
      createdAt: 2,
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
              blobId: "blob-missing",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-note",
                revision: 3,
                blobId: "blob-missing",
                path: "Folder/note.md",
                hash: "remote-hash",
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
      vaultAdapter: adapter,
      pullClient: createPullClient({ blobs: {} }),
      onProgress: ignoreProgress,
      onConflict(event) {
        conflicts.push({
          entryId: event.entryId,
          reason: event.reason,
          originalPath: event.originalPath,
          conflictPath: event.conflictPath,
        });
      },
      now: conflictTimestamp,
    });

    await expect(service.pullOnce(session)).rejects.toThrow("missing blob fixture");
    expect(adapter.text("Folder/note.md")).toBe("local body");
    expect(adapter.text("Folder/note.sync-conflict-20260422-101112.md")).toBeNull();
    expect(await store.listDirtyEntries()).toMatchObject([
      {
        mutationId: "mutation-note",
        entryId: "entry-note",
      },
    ]);
    expect(await store.getEntryById("entry-note")).toMatchObject({
      path: "Folder/note.md",
      revision: 2,
    });
    expect(await store.getCursor()).toBe(0);
    expect(conflicts).toEqual([]);

    await store.close();
  });

  it("does not remove pending mutations before every blob is prepared", async () => {
    const store = createTestSyncStore();
    const adapter = createVaultAdapter({
      "Folder/a.md": "local a",
      "Folder/b.md": "old b",
    });
    const conflicts: PullConflictSummary[] = [];
    await store.upsertEntry({
      entryId: "entry-a",
      path: "Folder/a.md",
      revision: 1,
      blobId: "blob-a-old",
      hash: "local-a-hash",
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
    await store.markEntryDirty({
      mutationId: "mutation-a",
      entryId: "entry-a",
      op: "upsert",
      baseRevision: 1,
      blobId: "blob-a-local",
      hash: "local-a-hash",
      encryptedMetadata: await encryptPendingMetadata({
        entryId: "entry-a",
        baseRevision: 1,
        op: "upsert",
        blobId: "blob-a-local",
        path: "Folder/a.md",
        hash: "local-a-hash",
      }),
      createdAt: 2,
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
              blobId: "blob-b-missing",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-b",
                revision: 2,
                blobId: "blob-b-missing",
                path: "Folder/b.md",
                hash: await hashText("new b"),
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
      vaultAdapter: adapter,
      pullClient: createPullClient({
        blobs: {
          "blob-a-new": await encryptTestBlob("blob-a-new", new TextEncoder().encode("new a")),
        },
      }),
      prepareConcurrency: 1,
      onProgress: ignoreProgress,
      onConflict(event) {
        conflicts.push({
          entryId: event.entryId,
          reason: event.reason,
          originalPath: event.originalPath,
          conflictPath: event.conflictPath,
        });
      },
      now: conflictTimestamp,
    });

    await expect(service.pullOnce(session)).rejects.toThrow("missing blob fixture");
    expect(adapter.text("Folder/a.md")).toBe("local a");
    expect(adapter.text("Folder/a.sync-conflict-20260422-101112.md")).toBeNull();
    expect(await store.listDirtyEntries()).toMatchObject([
      {
        mutationId: "mutation-a",
        entryId: "entry-a",
      },
    ]);
    expect(conflicts).toEqual([]);

    await store.close();
  });

  it("checkpoints a completed pull window before a later window fails", async () => {
    const store = createTestSyncStore();
    const adapter = createVaultAdapter();
    const bodies = {
      "blob-a": "new a",
      "blob-b": "new b",
    };

    const session = createRealtimeSession({
      pages: [
        {
          cursor: 3,
          hasMore: true,
          commits: [
            createCommit({
              cursor: 1,
              entryId: "entry-a",
              revision: 1,
              blobId: "blob-a",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-a",
                revision: 1,
                blobId: "blob-a",
                path: "Folder/a.md",
                hash: await hashText(bodies["blob-a"]),
              }),
            }),
            createCommit({
              cursor: 2,
              entryId: "entry-b",
              revision: 1,
              blobId: "blob-b",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-b",
                revision: 1,
                blobId: "blob-b",
                path: "Folder/b.md",
                hash: await hashText(bodies["blob-b"]),
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
              entryId: "entry-c",
              revision: 1,
              blobId: "blob-c-missing",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-c",
                revision: 1,
                blobId: "blob-c-missing",
                path: "Folder/c.md",
                hash: await hashText("new c"),
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
      vaultAdapter: adapter,
      pullClient: createPullClient({
        blobs: {
          "blob-a": await encryptTestBlob("blob-a", new TextEncoder().encode(bodies["blob-a"])),
          "blob-b": await encryptTestBlob("blob-b", new TextEncoder().encode(bodies["blob-b"])),
        },
      }),
      applyWindowSize: 2,
      onProgress: ignoreProgress,
    });

    await expect(service.pullOnce(session)).rejects.toThrow("missing blob fixture");
    expect(adapter.text("Folder/a.md")).toBe("new a");
    expect(adapter.text("Folder/b.md")).toBe("new b");
    expect(adapter.text("Folder/c.md")).toBeNull();
    expect(await store.getCursor()).toBe(2);

    await store.close();
  });

  it("does not apply entries after a deferred window item before checkpointing", async () => {
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
          cursor: 3,
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
              blobId: "blob-b-missing",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-b",
                revision: 2,
                blobId: "blob-b-missing",
                path: "Folder/a.md",
                hash: await hashText("new b"),
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
      vaultAdapter: adapter,
      pullClient: createPullClient({
        blobs: {
          "blob-a-new": await encryptTestBlob("blob-a-new", new TextEncoder().encode("new a")),
          "blob-filler": await encryptTestBlob("blob-filler", new TextEncoder().encode("filler")),
        },
      }),
      applyWindowSize: 2,
      onProgress: ignoreProgress,
    });

    await expect(service.pullOnce(session)).rejects.toThrow("missing blob fixture");
    expect(adapter.text("Folder/a.md")).toBe("old a");
    expect(adapter.text("Folder/b.md")).toBe("old b");
    expect(adapter.text("Folder/filler.md")).toBeNull();
    expect(await store.getCursor()).toBe(0);

    await store.close();
  });

});
