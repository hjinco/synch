import { describe, expect, it } from "vitest";

import { encodeUtf8, hashBytes } from "../../../core/content";
import { createTestSyncStore } from "../../../../test-support/in-memory-sync-store";
import { SyncEventRecorder } from "../../event-recorder";
import {
  decryptPendingMetadata,
  encryptTestMetadata,
  putTestBaseBlob,
  TEST_VAULT_KEY,
} from "./helpers";

describe("SyncEventRecorder synced entries", () => {
  it("queues a delete mutation for a previously synced file", async () => {
    const store = createTestSyncStore();
    const recorder = new SyncEventRecorder({
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
    });

    await store.upsertEntry({
      entryId: "entry-1",
      path: "Folder/file.md",
      revision: 7,
      blobId: "blob-1",
      hash: "hash-1",
      deleted: false,
      updatedAt: 1,
    });

    await recorder.recordDelete("Folder/file.md");

    expect(await store.getEntryById("entry-1")).toEqual({
      entryId: "entry-1",
      path: null,
      revision: 7,
      blobId: null,
      hash: null,
      deleted: true,
      updatedAt: expect.any(Number),
      localMtime: null,
      localSize: null,
    });

    const pending = await store.listDirtyEntries();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      mutationId: expect.any(String),
      entryId: "entry-1",
      op: "delete",
      baseRevision: 7,
      blobId: null,
      hash: null,
      encryptedMetadata: expect.any(String),
      createdAt: expect.any(Number),
    });
    await expect(
      decryptPendingMetadata(pending[0]),
    ).resolves.toEqual({
      path: "Folder/file.md",
      hash: null,
    });

    await store.close();
  });

  it("ignores unchanged upserts without queuing a mutation", async () => {
    const store = createTestSyncStore();
    const recorder = new SyncEventRecorder({
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
    });
    const bytes = encodeUtf8("synced body");
    const hash = await hashBytes(bytes);

    await store.upsertEntry({
      entryId: "entry-1",
      path: "Folder/file.md",
      revision: 7,
      blobId: "blob-1",
      hash,
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: null,
    });

    await expect(recorder.recordUpsert("Folder/file.md", bytes)).resolves.toBe(false);

    expect(await store.getEntryById("entry-1")).toEqual({
      entryId: "entry-1",
      path: "Folder/file.md",
      revision: 7,
      blobId: "blob-1",
      hash,
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: null,
    });
    expect(await store.listDirtyEntries()).toEqual([]);
    await store.close();
  });

  it("does not reuse a locally renamed entry for a new file at the original path", async () => {
    const store = createTestSyncStore();
    const recorder = new SyncEventRecorder({
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
    });
    const oldPath = "Folder/file.md";
    const nextPath = "Folder/renamed.md";
    const renamedBytes = encodeUtf8("renamed body");
    const renamedHash = await hashBytes(renamedBytes);
    const newBytes = encodeUtf8("new file body");
    const newHash = await hashBytes(newBytes);

    await store.upsertEntry({
      entryId: "entry-renamed",
      path: oldPath,
      revision: 4,
      blobId: "blob-renamed",
      hash: renamedHash,
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: null,
    });
    await putTestBaseBlob(store, {
      blobId: "blob-renamed",
      hash: renamedHash,
      bytes: renamedBytes,
    });

    await expect(recorder.recordRename(oldPath, nextPath, renamedBytes)).resolves.toBe(true);
    await expect(recorder.recordUpsert(oldPath, newBytes)).resolves.toBe(true);

    expect(await store.getEntryByPath(nextPath)).toMatchObject({
      entryId: "entry-renamed",
      revision: 4,
      path: nextPath,
      hash: renamedHash,
    });
    const newEntry = await store.getEntryByPath(oldPath);
    expect(newEntry).toMatchObject({
      entryId: expect.any(String),
      revision: 0,
      path: oldPath,
      hash: newHash,
    });
    expect(newEntry?.entryId).not.toBe("entry-renamed");

    const pending = await store.listDirtyEntries();
    expect(pending).toHaveLength(2);
    await expect(
      decryptPendingMetadata(pending.find((item) => item.entryId === "entry-renamed")),
    ).resolves.toEqual({
      path: nextPath,
      hash: renamedHash,
    });
    await expect(
      decryptPendingMetadata(pending.find((item) => item.entryId === newEntry?.entryId)),
    ).resolves.toEqual({
      path: oldPath,
      hash: newHash,
    });
    await store.close();
  });

  it("replaces a pending delete when unchanged content is upserted again", async () => {
    const store = createTestSyncStore();
    const recorder = new SyncEventRecorder({
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
    });
    const bytes = encodeUtf8("synced body");
    const hash = await hashBytes(bytes);

    await store.upsertEntry({
      entryId: "entry-1",
      path: "Folder/file.md",
      revision: 7,
      blobId: "blob-1",
      hash,
      deleted: false,
      updatedAt: 1,
    });
    await putTestBaseBlob(store, {
      blobId: "blob-1",
      hash,
      bytes,
    });
    await store.markEntryDirty({
      mutationId: "mutation-delete",
      entryId: "entry-1",
      op: "delete",
      baseRevision: 7,
      blobId: null,
      hash: null,
      encryptedMetadata: await encryptTestMetadata({
        entryId: "entry-1",
        revision: 8,
        op: "delete",
        blobId: null,
        path: "Folder/file.md",
      }),
      createdAt: 1,
    });

    await expect(recorder.recordUpsert("Folder/file.md", bytes)).resolves.toBe(true);

    const pending = await store.getDirtyEntryMutation("entry-1");
    expect(pending).toMatchObject({
      entryId: "entry-1",
      op: "upsert",
      baseRevision: 7,
      blobId: "blob-1",
      hash,
    });
    await expect(
      decryptPendingMetadata(pending),
    ).resolves.toEqual({
      path: "Folder/file.md",
      hash,
    });
    await store.close();
  });

  it("replaces a pending delete for a tombstoned entry when the path is restored", async () => {
    const store = createTestSyncStore();
    const recorder = new SyncEventRecorder({
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
    });
    const bytes = encodeUtf8("restored body");
    const hash = await hashBytes(bytes);

    await store.upsertEntry({
      entryId: "entry-1",
      path: null,
      revision: 7,
      blobId: null,
      hash: null,
      deleted: true,
      updatedAt: 1,
      localMtime: null,
      localSize: null,
    });
    await store.markEntryDirty({
      mutationId: "mutation-delete",
      entryId: "entry-1",
      op: "delete",
      baseRevision: 7,
      blobId: null,
      hash: null,
      encryptedMetadata: await encryptTestMetadata({
        entryId: "entry-1",
        revision: 8,
        op: "delete",
        blobId: null,
        path: "Folder/file.md",
      }),
      createdAt: 1,
    });

    await expect(
      recorder.recordUpsert("Folder/file.md", bytes, {
        mtime: 10,
        size: bytes.byteLength,
      }),
    ).resolves.toBe(true);

    const pending = await store.listDirtyEntries();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      entryId: "entry-1",
      op: "upsert",
      baseRevision: 7,
      hash,
    });
    await expect(decryptPendingMetadata(pending[0])).resolves.toEqual({
      path: "Folder/file.md",
      hash,
    });
    expect(await store.getEntryByPath("Folder/file.md")).toMatchObject({
      entryId: "entry-1",
      revision: 7,
      hash,
      deleted: false,
      localMtime: 10,
      localSize: bytes.byteLength,
    });
    await store.close();
  });

  it("finds a restored pending delete beyond the first 100 pending mutations", async () => {
    const store = createTestSyncStore();
    const recorder = new SyncEventRecorder({
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
    });
    const bytes = encodeUtf8("late restore body");
    const hash = await hashBytes(bytes);

    for (let index = 0; index < 100; index += 1) {
      const entryId = `entry-earlier-${index}`;
      await store.upsertEntry({
        entryId,
        path: null,
        revision: 1,
        blobId: null,
        hash: null,
        deleted: true,
        updatedAt: index,
        localMtime: null,
        localSize: null,
      });
      await store.markEntryDirty({
        mutationId: `mutation-earlier-${index}`,
        entryId,
        op: "delete",
        baseRevision: 1,
        blobId: null,
        hash: null,
        encryptedMetadata: await encryptTestMetadata({
          entryId,
          revision: 2,
          op: "delete",
          blobId: null,
          path: `Earlier/${index}.md`,
        }),
        createdAt: index,
      });
    }

    await store.upsertEntry({
      entryId: "entry-late",
      path: null,
      revision: 7,
      blobId: null,
      hash: null,
      deleted: true,
      updatedAt: 101,
      localMtime: null,
      localSize: null,
    });
    await store.markEntryDirty({
      mutationId: "mutation-late-delete",
      entryId: "entry-late",
      op: "delete",
      baseRevision: 7,
      blobId: null,
      hash: null,
      encryptedMetadata: await encryptTestMetadata({
        entryId: "entry-late",
        revision: 8,
        op: "delete",
        blobId: null,
        path: "Folder/late.md",
      }),
      createdAt: 101,
    });

    await expect(recorder.recordUpsert("Folder/late.md", bytes)).resolves.toBe(true);

    const pending = await store.getDirtyEntryMutation("entry-late");
    expect(pending).toMatchObject({
      entryId: "entry-late",
      op: "upsert",
      baseRevision: 7,
      hash,
    });
    await expect(decryptPendingMetadata(pending)).resolves.toEqual({
      path: "Folder/late.md",
      hash,
    });
    expect(await store.getEntryByPath("Folder/late.md")).toMatchObject({
      entryId: "entry-late",
      revision: 7,
      hash,
      deleted: false,
    });
    await store.close();
  });
});
