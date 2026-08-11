import { describe, expect, it } from "vitest";

import { encodeUtf8, hashBytes } from "../../../core/content";
import { createTestSyncStore } from "../../../../test-support/in-memory-sync-store";
import { SyncLocalReconcileService } from "../../local-reconcile-service";
import { localFile, TEST_VAULT_KEY } from "./helpers";

describe("SyncLocalReconcileService stat cache", () => {
  it("skips reading unchanged files when local stat cache matches", async () => {
    const store = createTestSyncStore();
    const hash = await hashBytes(encodeUtf8("same body"));
    await store.upsertEntry({
      entryId: "entry-unchanged",
      path: "Folder/file.md",
      revision: 4,
      blobId: "blob-unchanged",
      hash,
      deleted: false,
      updatedAt: 1,
      localMtime: 10,
      localSize: 9,
    });
    let reads = 0;

    const service = new SyncLocalReconcileService({
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      shouldSyncPath: () => true,
      scanner: {
        async listFiles() {
          return [
            {
              path: "Folder/file.md",
              mtime: 10,
              size: 9,
              async readBytes() {
                reads += 1;
                return encodeUtf8("same body");
              },
            },
          ];
        },
      },
    });

    await expect(service.reconcileOnce()).resolves.toEqual({
      filesScanned: 1,
      filesQueuedForUpsert: 0,
      filesQueuedForDelete: 0,
    });
    expect(reads).toBe(0);
    expect(await store.listDirtyEntries()).toEqual([]);
    await store.close();
  });

  it("updates only local stat cache when hash still matches", async () => {
    const store = createTestSyncStore();
    const bytes = encodeUtf8("same body");
    const hash = await hashBytes(bytes);
    await store.upsertEntry({
      entryId: "entry-stat-changed",
      path: "Folder/file.md",
      revision: 4,
      blobId: "blob-stat-changed",
      hash,
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: null,
    });

    const service = new SyncLocalReconcileService({
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      shouldSyncPath: () => true,
      scanner: {
        async listFiles() {
          return [localFile("Folder/file.md", bytes)];
        },
      },
    });

    await expect(service.reconcileOnce()).resolves.toEqual({
      filesScanned: 1,
      filesQueuedForUpsert: 0,
      filesQueuedForDelete: 0,
    });
    expect(await store.getEntryById("entry-stat-changed")).toMatchObject({
      entryId: "entry-stat-changed",
      hash,
      localMtime: 10,
      localSize: bytes.byteLength,
    });
    expect(await store.listDirtyEntries()).toEqual([]);
    await store.close();
  });
});
