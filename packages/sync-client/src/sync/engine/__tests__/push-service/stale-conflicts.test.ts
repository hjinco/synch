import { describe, expect, it } from "vitest";

import { encodeUtf8, hashBytes } from "../../../core/content";
import { SyncRealtimeError, type CommitMutationPayload } from "../../../remote/realtime-client";
import { createTestSyncStore } from "../../../../test-support/in-memory-sync-store";
import { SyncPullService } from "../../pull-service";
import { SyncPushService } from "../../push-service";
import {
  arrangePendingUpsertWithCachedBase,
  createPullClient,
  createRealtimeSession,
  createVaultAdapter,
  encryptRemoteMetadata,
  encryptTestBlob,
} from "../pull-service/helpers";
import {
  createPushSession,
  createToken,
  encryptMutationMetadata,
  ignoreProgress,
  TEST_VAULT_KEY,
} from "./helpers";

const conflictTimestamp = () => new Date(2026, 3, 22, 10, 11, 12).getTime();

describe("SyncPushService stale revisions", () => {
  it("creates a conflict copy when stale rejection shows the server is behind", async () => {
    const store = createTestSyncStore();
    const upsertHash = await hashBytes(encodeUtf8("local body"));
    const upsertBlobId = "blob-note-next";
    await store.setCursor(17);
    await store.upsertEntry({
      entryId: "entry-note",
      path: "Welcomed.md",
      revision: 1,
      blobId: "blob-note-current",
      hash: upsertHash,
      deleted: false,
      updatedAt: 1,
    });
    await store.markEntryDirty({
      mutationId: "mutation-note",
      entryId: "entry-note",
      op: "upsert",
      baseRevision: 1,
      blobId: upsertBlobId,
      hash: upsertHash,
      encryptedMetadata: await encryptMutationMetadata({
        entryId: "entry-note",
        baseRevision: 1,
        op: "upsert",
        blobId: upsertBlobId,
        path: "Welcomed.md",
        hash: upsertHash,
      }),
      createdAt: 2,
    });

    const committed: Array<CommitMutationPayload> = [];
    const written: Array<{ path: string; bytes: string }> = [];
    const session = createPushSession(async (mutation) => {
      committed.push(mutation);
      throw new SyncRealtimeError(
        "stale_revision",
        "expected base revision 0 but received 1",
        { expectedBaseRevision: 0, receivedBaseRevision: 1 },
      );
    });
    const service = new SyncPushService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      fileReader: {
        async readBytes(path) {
          expect(path).toBe("Welcomed.md");
          return new TextEncoder().encode("local body");
        },
      },
      blobClient: {
        async uploadBlob() {},
      },
      conflictFileWriter: {
        async exists() {
          return false;
        },
        async mkdir() {},
        async writeBinary(path, content) {
          written.push({
            path,
            bytes: new TextDecoder().decode(content),
          });
        },
      },
      onProgress: ignoreProgress,
      now: conflictTimestamp,
    });

    await expect(service.pushPendingMutations(session)).resolves.toEqual({
      cursor: 17,
      mutationsPushed: 0,
      mutationsRequeued: 0,
      filesCreatedOrUpdated: 0,
      filesDeleted: 0,
      conflictsCreated: 1,
      shouldPullAfterPush: false,
      hasMore: false,
    });
    expect(committed.map(({ baseRevision }) => baseRevision)).toEqual([1]);
    expect(written).toEqual([
      {
        path: "Welcomed.sync-conflict-20260422-101112.md",
        bytes: "local body",
      },
    ]);
    expect(await store.listDirtyEntries()).toEqual([]);
    expect(await store.getCursor()).toBe(17);
    expect((await store.getEntryById("entry-note"))?.revision).toBe(1);

    await store.close();
  });

  it("preserves a stale rejected mutation for pull/rebase", async () => {
    const store = createTestSyncStore();
    const upsertHash = await hashBytes(encodeUtf8("local body"));
    const upsertBlobId = "blob-note-next";
    await store.upsertEntry({
      entryId: "entry-note",
      path: "Folder/note.md",
      revision: 2,
      blobId: "blob-note-current",
      hash: upsertHash,
      deleted: false,
      updatedAt: 1,
    });
    await store.markEntryDirty({
      mutationId: "mutation-note",
      entryId: "entry-note",
      op: "upsert",
      baseRevision: 2,
      blobId: upsertBlobId,
      hash: upsertHash,
      encryptedMetadata: await encryptMutationMetadata({
        entryId: "entry-note",
        baseRevision: 2,
        op: "upsert",
        blobId: upsertBlobId,
        path: "Folder/note.md",
        hash: upsertHash,
      }),
      createdAt: 2,
    });

    const session = createPushSession(async () => {
      throw new SyncRealtimeError(
        "stale_revision",
        "expected base revision 3 but received 2",
        { expectedBaseRevision: 3, receivedBaseRevision: 2 },
      );
    });
    const service = new SyncPushService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      fileReader: {
        async readBytes(path) {
          expect(path).toBe("Folder/note.md");
          return new TextEncoder().encode("local body");
        },
      },
      blobClient: {
        async uploadBlob() {},
      },
      onProgress: ignoreProgress,
    });

    await expect(service.pushPendingMutations(session)).resolves.toEqual({
      cursor: 0,
      mutationsPushed: 0,
      mutationsRequeued: 1,
      filesCreatedOrUpdated: 0,
      filesDeleted: 0,
      conflictsCreated: 0,
      shouldPullAfterPush: true,
      hasMore: true,
    });
    expect(await store.listDirtyEntries()).toMatchObject([
      {
        mutationId: "mutation-note",
        entryId: "entry-note",
        op: "upsert",
        baseRevision: 2,
      },
    ]);
    await store.close();
  });

  it("does not checkpoint accepted cursors from a stale batch", async () => {
    const store = createTestSyncStore();
    const noteHash = await hashBytes(encodeUtf8("local note"));
    const taskHash = await hashBytes(encodeUtf8("local task"));
    await store.setCursor(7);
    await store.upsertEntry({
      entryId: "entry-note",
      path: "Folder/note.md",
      revision: 2,
      blobId: "blob-note-current",
      hash: noteHash,
      deleted: false,
      updatedAt: 1,
    });
    await store.upsertEntry({
      entryId: "entry-task",
      path: "Folder/task.md",
      revision: 4,
      blobId: "blob-task-current",
      hash: taskHash,
      deleted: false,
      updatedAt: 1,
    });
    await store.markEntryDirty({
      mutationId: "mutation-note",
      entryId: "entry-note",
      op: "upsert",
      baseRevision: 2,
      blobId: "blob-note-next",
      hash: noteHash,
      encryptedMetadata: await encryptMutationMetadata({
        entryId: "entry-note",
        baseRevision: 2,
        op: "upsert",
        blobId: "blob-note-next",
        path: "Folder/note.md",
        hash: noteHash,
      }),
      createdAt: 2,
    });
    await store.markEntryDirty({
      mutationId: "mutation-task",
      entryId: "entry-task",
      op: "upsert",
      baseRevision: 4,
      blobId: "blob-task-next",
      hash: taskHash,
      encryptedMetadata: await encryptMutationMetadata({
        entryId: "entry-task",
        baseRevision: 4,
        op: "upsert",
        blobId: "blob-task-next",
        path: "Folder/task.md",
        hash: taskHash,
      }),
      createdAt: 3,
    });

    const session = createPushSession(async (mutation) => {
      if (mutation.entryId === "entry-note") {
        throw new SyncRealtimeError(
          "stale_revision",
          "expected base revision 3 but received 2",
          { expectedBaseRevision: 3, receivedBaseRevision: 2 },
        );
      }

      return {
        cursor: 42,
        entryId: mutation.entryId,
        revision: mutation.baseRevision + 1,
      };
    });
    const service = new SyncPushService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      fileReader: {
        async readBytes(path) {
          return encodeUtf8(path === "Folder/note.md" ? "local note" : "local task");
        },
      },
      blobClient: {
        async uploadBlob() {},
      },
      onProgress: ignoreProgress,
    });

    await expect(service.pushPendingMutations(session)).resolves.toMatchObject({
      mutationsPushed: 1,
      mutationsRequeued: 1,
      shouldPullAfterPush: true,
      hasMore: true,
    });
    expect(await store.getCursor()).toBe(7);
    expect(await store.listDirtyEntries()).toMatchObject([
      {
        mutationId: "mutation-note",
        entryId: "entry-note",
        baseRevision: 2,
      },
    ]);
    await store.close();
  });

  it("keeps accepted batch results when a later rejection throws", async () => {
    const store = createTestSyncStore();
    const noteHash = await hashBytes(encodeUtf8("local note"));
    const taskHash = await hashBytes(encodeUtf8("local task"));
    await store.upsertEntry({
      entryId: "entry-note",
      path: "Folder/note.md",
      revision: 1,
      blobId: "blob-note-current",
      hash: noteHash,
      deleted: false,
      updatedAt: 1,
    });
    await store.upsertEntry({
      entryId: "entry-task",
      path: "Folder/task.md",
      revision: 1,
      blobId: "blob-task-current",
      hash: taskHash,
      deleted: false,
      updatedAt: 1,
    });
    await store.markEntryDirty({
      mutationId: "mutation-note",
      entryId: "entry-note",
      op: "upsert",
      baseRevision: 1,
      blobId: "blob-note-next",
      hash: noteHash,
      encryptedMetadata: await encryptMutationMetadata({
        entryId: "entry-note",
        baseRevision: 1,
        op: "upsert",
        blobId: "blob-note-next",
        path: "Folder/note.md",
        hash: noteHash,
      }),
      createdAt: 2,
    });
    await store.markEntryDirty({
      mutationId: "mutation-task",
      entryId: "entry-task",
      op: "upsert",
      baseRevision: 1,
      blobId: "blob-task-next",
      hash: taskHash,
      encryptedMetadata: await encryptMutationMetadata({
        entryId: "entry-task",
        baseRevision: 1,
        op: "upsert",
        blobId: "blob-task-next",
        path: "Folder/task.md",
        hash: taskHash,
      }),
      createdAt: 3,
    });

    const session = createPushSession(
      async () => {
        throw new Error("single commit should not be used");
      },
      async () => ({
        cursor: 2,
        results: [
          {
            status: "accepted",
            mutationId: "mutation-note",
            entryId: "entry-note",
            cursor: 1,
            revision: 2,
          },
          {
            status: "rejected",
            mutationId: "mutation-task",
            entryId: "entry-task",
            code: "unavailable",
            message: "service unavailable",
          },
        ],
      }),
    );
    const service = new SyncPushService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      fileReader: {
        async readBytes(path) {
          return encodeUtf8(path === "Folder/note.md" ? "local note" : "local task");
        },
      },
      blobClient: {
        async uploadBlob() {},
      },
      onProgress: ignoreProgress,
    });

    await expect(service.pushPendingMutations(session)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(await store.getRemoteStateById("entry-note")).toMatchObject({
      revision: 2,
      blobId: "blob-note-next",
      hash: noteHash,
    });
    expect(await store.listDirtyEntries()).toMatchObject([
      {
        mutationId: "mutation-task",
        entryId: "entry-task",
      },
    ]);

    await store.close();
  });

  it("rebases a clean text pending mutation after pull and retries push from the new base", async () => {
    const store = createTestSyncStore();
    const path = "Folder/note.md";
    const entryId = "entry-note";
    const baseText = "Title\n\noriginal line\n";
    const localText = "Title\n\nlocal line\n";
    const remoteText = "Remote title\n\noriginal line\n";
    const mergedText = "Remote title\n\nlocal line\n";
    const baseHash = await hashBytes(encodeUtf8(baseText));
    const localHash = await hashBytes(encodeUtf8(localText));
    const remoteHash = await hashBytes(encodeUtf8(remoteText));
    const mergedHash = await hashBytes(encodeUtf8(mergedText));
    const adapter = createVaultAdapter({
      [path]: localText,
    });

    await store.setCursor(8);
    await arrangePendingUpsertWithCachedBase(store, {
      entryId,
      path,
      baseRevision: 2,
      baseBlobId: "blob-base",
      baseHash,
      baseBytes: encodeUtf8(baseText),
      localBlobId: "blob-local",
      localHash,
      createdAt: 2,
    });

    const pullSession = createRealtimeSession({
      pages: [
        {
          cursor: 9,
          hasMore: false,
          commits: [
            {
              cursor: 9,
              entryId,
              op: "upsert",
              revision: 3,
              baseRevision: 2,
              blobId: "blob-remote",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId,
                revision: 3,
                blobId: "blob-remote",
                path,
                hash: remoteHash,
              }),
              committedAt: 9,
              committedByUserId: "user-1",
              committedByLocalVaultId: "remote-vault-2",
            },
          ],
        },
      ],
    });
    const pullService = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      vaultAdapter: adapter,
      pullClient: createPullClient({
        blobs: {
          "blob-remote": await encryptTestBlob("blob-remote", encodeUtf8(remoteText)),
        },
      }),
      onProgress: ignoreProgress,
    });

    await expect(pullService.pullOnce(pullSession)).resolves.toEqual({
      cursor: 9,
      entriesApplied: 1,
      filesWritten: 1,
      filesDeleted: 0,
      conflictsCreated: 0,
    });

    const rebased = await store.getDirtyEntryMutation(entryId);
    expect(adapter.text(path)).toBe(mergedText);
    expect(rebased).toMatchObject({
      entryId,
      op: "upsert",
      baseRevision: 3,
      baseBlobId: "blob-remote",
      baseHash: remoteHash,
      hash: mergedHash,
    });
    expect(await store.getRemoteStateById(entryId)).toMatchObject({
      revision: 3,
      blobId: "blob-remote",
      hash: remoteHash,
    });
    expect(await store.getLocalStateById(entryId)).toMatchObject({
      path,
      blobId: rebased?.blobId,
      hash: mergedHash,
    });

    const committed: CommitMutationPayload[] = [];
    const pushSession = createPushSession(async (mutation) => {
      committed.push(mutation);
      return {
        cursor: 10,
        entryId: mutation.entryId,
        revision: mutation.baseRevision + 1,
      };
    });
    const pushService = new SyncPushService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      fileReader: {
        async readBytes(readPath) {
          expect(readPath).toBe(path);
          const bytes = adapter.bytes(readPath);
          if (!bytes) {
            throw new Error(`missing local bytes for ${readPath}`);
          }
          return bytes;
        },
      },
      blobClient: {
        async uploadBlob() {},
      },
      onProgress: ignoreProgress,
    });

    await expect(pushService.pushPendingMutations(pushSession)).resolves.toEqual({
      cursor: 10,
      mutationsPushed: 1,
      mutationsRequeued: 0,
      filesCreatedOrUpdated: 1,
      filesDeleted: 0,
      conflictsCreated: 0,
      shouldPullAfterPush: false,
      hasMore: false,
    });
    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({
      mutationId: rebased?.mutationId,
      entryId,
      op: "upsert",
      baseRevision: 3,
      blobId: rebased?.blobId,
    });
    expect(await store.listDirtyEntries()).toEqual([]);
    expect(await store.getRemoteStateById(entryId)).toMatchObject({
      revision: 4,
      hash: mergedHash,
    });
    expect(await store.getCursor()).toBe(10);

    await store.close();
  });
});
