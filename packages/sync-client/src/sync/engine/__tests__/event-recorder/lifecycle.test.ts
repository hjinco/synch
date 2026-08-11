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

describe("SyncEventRecorder lifecycle", () => {
  it("coalesces create, modify, rename, and delete for an unsynced file", async () => {
    const store = createTestSyncStore();
    const recorder = new SyncEventRecorder({
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
    });

    await recorder.recordUpsert("Folder/file.md", encodeUtf8("draft v1"));
    const createdEntry = await store.getEntryByPath("Folder/file.md");
    const createdPending = createdEntry
      ? await store.getDirtyEntryMutation(createdEntry.entryId)
      : null;

    expect(createdEntry?.revision).toBe(0);
    await expect(
      decryptPendingMetadata(createdPending),
    ).resolves.toEqual({
      path: "Folder/file.md",
      hash: createdPending?.hash,
    });
    expect(createdPending?.blobId).toBe(createdEntry?.blobId);
    expect(createdPending?.hash).toBe(createdEntry?.hash);

    await recorder.recordUpsert("Folder/file.md", encodeUtf8("draft v2"));
    const modifiedPending = createdEntry
      ? await store.getDirtyEntryMutation(createdEntry.entryId)
      : null;
    await expect(
      decryptPendingMetadata(modifiedPending),
    ).resolves.toEqual({
      path: "Folder/file.md",
      hash: modifiedPending?.hash,
    });
    expect(modifiedPending?.blobId).toBe((await store.getEntryByPath("Folder/file.md"))?.blobId);
    expect(modifiedPending?.hash).toBe(
      (await store.getEntryByPath("Folder/file.md"))?.hash,
    );
    expect((await store.listDirtyEntries()).length).toBe(1);

    await recorder.recordRename(
      "Folder/file.md",
      "Folder/renamed.md",
      encodeUtf8("draft v2"),
    );
    expect(await store.getEntryByPath("Folder/file.md")).toBeNull();
    expect(await store.getEntryByPath("Folder/renamed.md")).toEqual({
      entryId: createdEntry?.entryId,
      path: "Folder/renamed.md",
      revision: 0,
      blobId: expect.any(String),
      hash: expect.any(String),
      deleted: false,
      updatedAt: expect.any(Number),
      localMtime: null,
      localSize: null,
    });

    const renamedPending = createdEntry
      ? await store.getDirtyEntryMutation(createdEntry.entryId)
      : null;
    await expect(
      decryptPendingMetadata(renamedPending),
    ).resolves.toEqual({
      path: "Folder/renamed.md",
      hash: renamedPending?.hash,
    });
    expect(renamedPending?.blobId).toBe((await store.getEntryByPath("Folder/renamed.md"))?.blobId);
    expect(renamedPending?.hash).toBe(
      (await store.getEntryByPath("Folder/renamed.md"))?.hash,
    );

    await recorder.recordDelete("Folder/renamed.md");
    expect(await store.getEntryByPath("Folder/renamed.md")).toBeNull();
    expect((await store.listDirtyEntries()).length).toBe(0);

    await store.close();
  });

  it("ignores rename events when the target path already matches the synced entry", async () => {
    const store = createTestSyncStore();
    const bytes = encodeUtf8("synced body");
    const hash = await hashBytes(bytes);
    await store.upsertEntry({
      entryId: "entry-synced",
      path: "Folder/file.md",
      revision: 3,
      blobId: "blob-synced",
      hash,
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: null,
    });
    await putTestBaseBlob(store, {
      blobId: "blob-synced",
      hash,
      bytes,
    });
    const recorder = new SyncEventRecorder({
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
    });

    const changed = await recorder.recordRename(
      "Folder/old-name-from-event.md",
      "Folder/file.md",
      bytes,
      { mtime: 10, size: bytes.byteLength },
    );

    expect(changed).toBe(false);
    expect(await store.listDirtyEntries()).toEqual([]);
    expect(await store.getEntryByPath("Folder/file.md")).toMatchObject({
      entryId: "entry-synced",
      revision: 3,
      blobId: "blob-synced",
      hash,
      localMtime: 10,
      localSize: bytes.byteLength,
    });
    await store.close();
  });

  it("replaces pending deletes when a stale rename event matches the synced entry", async () => {
    const store = createTestSyncStore();
    const bytes = encodeUtf8("synced body");
    const hash = await hashBytes(bytes);
    await store.upsertEntry({
      entryId: "entry-synced",
      path: "Folder/file.md",
      revision: 3,
      blobId: "blob-synced",
      hash,
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: null,
    });
    await putTestBaseBlob(store, {
      blobId: "blob-synced",
      hash,
      bytes,
    });
    await store.markEntryDirty({
      mutationId: "mutation-delete",
      entryId: "entry-synced",
      op: "delete",
      baseRevision: 3,
      blobId: null,
      hash: null,
      encryptedMetadata: await encryptTestMetadata({
        entryId: "entry-synced",
        revision: 4,
        op: "delete",
        blobId: null,
        path: "Folder/file.md",
      }),
      createdAt: 2,
    });
    const recorder = new SyncEventRecorder({
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
    });

    const changed = await recorder.recordRename(
      "Folder/old-name-from-event.md",
      "Folder/file.md",
      bytes,
      { mtime: 10, size: bytes.byteLength },
    );

    expect(changed).toBe(true);
    const pending = await store.getDirtyEntryMutation("entry-synced");
    expect(pending).toMatchObject({
      entryId: "entry-synced",
      op: "upsert",
      baseRevision: 3,
      blobId: "blob-synced",
      hash,
    });
    await expect(decryptPendingMetadata(pending)).resolves.toEqual({
      path: "Folder/file.md",
      hash,
    });
    expect(await store.getEntryByPath("Folder/file.md")).toMatchObject({
      entryId: "entry-synced",
      revision: 3,
      blobId: "blob-synced",
      hash,
      localMtime: 10,
      localSize: bytes.byteLength,
    });
    await store.close();
  });
});
