import { describe, expect, it } from "vitest";

import { createTestSyncStore } from "../../../../test-support/in-memory-sync-store";
import { SyncLocalReconcileService } from "../../local-reconcile-service";
import {
  encryptTestMetadata,
  TEST_VAULT_KEY,
} from "./helpers";

describe("SyncLocalReconcileService cleanup", () => {
  it("drops unsynced files that disappeared before they were ever pushed", async () => {
    const store = createTestSyncStore();
    await store.upsertEntry({
      entryId: "entry-unsynced",
      path: "Folder/draft.md",
      revision: 0,
      blobId: "blob-draft",
      hash: "hash-1",
      deleted: false,
      updatedAt: 1,
    });
    await store.markEntryDirty({
      mutationId: "mutation-unsynced",
      entryId: "entry-unsynced",
      op: "upsert",
      baseRevision: 0,
      blobId: "blob-draft",
      hash: "hash-1",
      encryptedMetadata: await encryptTestMetadata({
        entryId: "entry-unsynced",
        revision: 1,
        op: "upsert",
        blobId: "blob-draft",
        path: "Folder/draft.md",
        hash: "hash-1",
      }),
      createdAt: 1,
    });

    const service = new SyncLocalReconcileService({
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      shouldSyncPath: () => true,
      scanner: {
        async listFiles() {
          return [];
        },
      },
    });

    const result = await service.reconcileOnce();

    expect(result).toEqual({
      filesScanned: 0,
      filesQueuedForUpsert: 0,
      filesQueuedForDelete: 0,
    });
    expect(await store.getEntryById("entry-unsynced")).toBeNull();
    expect(await store.listDirtyEntries()).toEqual([]);
    await store.close();
  });

  it("drops pending mutations for paths that are no longer syncable", async () => {
    const store = createTestSyncStore();
    await store.upsertEntry({
      entryId: "entry-local-only",
      path: "Assets/raw.bin",
      revision: 0,
      blobId: "blob-local",
      hash: "blob-local",
      deleted: false,
      updatedAt: 1,
    });
    await store.markEntryDirty({
      mutationId: "mutation-local-only",
      entryId: "entry-local-only",
      op: "upsert",
      baseRevision: 0,
      blobId: "blob-local",
      hash: "blob-local",
      encryptedMetadata: await encryptTestMetadata({
        entryId: "entry-local-only",
        revision: 1,
        op: "upsert",
        blobId: "blob-local",
        path: "Assets/raw.bin",
        hash: "blob-local",
      }),
      createdAt: 1,
    });
    await store.upsertEntry({
      entryId: "entry-remote",
      path: "Assets/remote.bin",
      revision: 5,
      blobId: "blob-remote",
      hash: "blob-remote",
      deleted: false,
      updatedAt: 2,
      localMtime: null,
      localSize: null,
    });
    await store.markEntryDirty({
      mutationId: "mutation-remote",
      entryId: "entry-remote",
      op: "upsert",
      baseRevision: 5,
      blobId: "blob-remote",
      hash: "blob-remote",
      encryptedMetadata: await encryptTestMetadata({
        entryId: "entry-remote",
        revision: 6,
        op: "upsert",
        blobId: "blob-remote",
        path: "Assets/remote.bin",
        hash: "blob-remote",
      }),
      createdAt: 2,
    });

    const service = new SyncLocalReconcileService({
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      shouldSyncPath: (path) => path !== "Assets/raw.bin" && path !== "Assets/remote.bin",
      scanner: {
        async listFiles() {
          return [];
        },
      },
    });

    const result = await service.reconcileOnce();

    expect(result).toEqual({
      filesScanned: 0,
      filesQueuedForUpsert: 0,
      filesQueuedForDelete: 0,
    });
    expect(await store.getEntryById("entry-local-only")).toBeNull();
    expect(await store.getEntryById("entry-remote")).toEqual({
      entryId: "entry-remote",
      path: "Assets/remote.bin",
      revision: 5,
      blobId: "blob-remote",
      hash: "blob-remote",
      deleted: false,
      updatedAt: 2,
      localMtime: null,
      localSize: null,
    });
    expect(await store.listDirtyEntries()).toEqual([]);

    await store.close();
  });
});
