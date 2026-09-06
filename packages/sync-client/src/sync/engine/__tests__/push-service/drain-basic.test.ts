import { createTestContentRuntime } from "../../../../test-support/content-runtime";
import { describe, expect, it } from "vitest";

import { encodeUtf8, hashBytes } from "../../../core/content";
import { decryptSyncBlob, decryptSyncMetadata } from "../../../core/crypto";
import type { CommitMutationPayload } from "../../../remote/realtime-client";
import { createTestSyncStore } from "../../../../test-support/in-memory-sync-store";
import { SyncPushService } from "../../push-service";
import {
  createPushSession,
  createToken,
  encryptMutationMetadata,
  ignoreProgress,
  metadataContextFromPayload,
  TEST_VAULT_KEY,
  unusedBlobClient,
} from "./helpers";

describe("SyncPushService drain: basic queue", () => {
  it("flushes queued mutations and updates the local store", async () => {
    const store = createTestSyncStore();
    const upsertHash = await hashBytes(encodeUtf8("new body"));
    const upsertBlobId = "blob-upsert-uuid";
    await store.markEntryDirty({
      mutationId: "mutation-upsert",
      entryId: "entry-upsert",
      op: "upsert",
      baseRevision: 0,
      blobId: upsertBlobId,
      hash: upsertHash,
      encryptedMetadata: await encryptMutationMetadata({
        entryId: "entry-upsert",
        baseRevision: 0,
        op: "upsert",
        blobId: upsertBlobId,
        path: "Folder/new.md",
        hash: upsertHash,
      }),
      createdAt: 1,
    });
    await store.markEntryDirty({
      mutationId: "mutation-delete",
      entryId: "entry-deleted",
      op: "delete",
      baseRevision: 2,
      blobId: null,
      hash: null,
      encryptedMetadata: await encryptMutationMetadata({
        entryId: "entry-deleted",
        baseRevision: 2,
        op: "delete",
        blobId: null,
        path: "Folder/deleted.md",
      }),
      createdAt: 2,
    });

    const committed: Array<CommitMutationPayload> = [];
    const uploaded: Array<{ blobId: string; bytes: Uint8Array }> = [];
    const fileSyncEvents: string[] = [];
    const progressUpdates: Array<{ completedEntries: number; totalEntries: number }> = [];
    let nextCursor = 10;
    const session = createPushSession(async (mutation) => {
      committed.push(mutation);
      nextCursor += 1;
      return {
        cursor: nextCursor,
        entryId: mutation.entryId,
        revision: mutation.baseRevision + 1,
      };
    });
    const service = new SyncPushService({
      contentRuntime: createTestContentRuntime(),
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      fileReader: {
        async readBytes(path) {
          if (path === "Folder/new.md") {
            return new TextEncoder().encode("new body");
          }

          throw new Error(`unexpected read for ${path}`);
        },
      },
      blobClient: {
        async uploadBlob(_vaultId, blobId, bytes) {
          uploaded.push({
            blobId,
            bytes,
          });
        },
      },
      onProgress: async (progress) => {
        progressUpdates.push(progress);
      },
      onFileSyncStarted: ({ operation, path }) => {
        fileSyncEvents.push(`started:${operation}:${path}`);
      },
      onFileSyncCompleted: ({ operation, path, revision }) => {
        fileSyncEvents.push(`completed:${operation}:${path}:${revision}`);
      },
    });

    const result = await service.pushPendingMutations(session);

    expect(result).toEqual({
      cursor: 12,
      mutationsPushed: 2,
      mutationsRequeued: 0,
      filesCreatedOrUpdated: 1,
      filesDeleted: 1,
      conflictsCreated: 0,
      shouldPullAfterPush: true,
      hasMore: false,
    });
    expect(progressUpdates[progressUpdates.length - 1]).toEqual({ direction: "push", totalKnown: true, completedEntries: 2, totalEntries: 2 });
    expect(committed.map(({ entryId, op, baseRevision }) => ({ entryId, op, baseRevision }))).toEqual(
      [
        {
          entryId: "entry-upsert",
          op: "upsert",
          baseRevision: 0,
        },
        {
          entryId: "entry-deleted",
          op: "delete",
          baseRevision: 2,
        },
      ],
    );
    expect(uploaded).toHaveLength(1);
    expect(fileSyncEvents.slice(0, 2)).toEqual(
      expect.arrayContaining([
        "started:upsert:Folder/new.md",
        "started:delete:Folder/deleted.md",
      ]),
    );
    expect(fileSyncEvents.slice(2)).toEqual([
      "completed:upsert:Folder/new.md:1",
      "completed:delete:Folder/deleted.md:3",
    ]);
    expect(new TextDecoder().decode(uploaded[0]?.bytes ?? new Uint8Array())).not.toBe("new body");
    expect(new TextDecoder().decode(uploaded[0]?.bytes.slice(0, 4))).toBe("SYNB");
    await expect(
      decryptSyncBlob(TEST_VAULT_KEY, uploaded[0]?.bytes ?? new Uint8Array(), {
        blobId: uploaded[0]?.blobId ?? "",
      }),
    ).resolves.toEqual(new TextEncoder().encode("new body"));
    await expect(
      decryptSyncMetadata(
        TEST_VAULT_KEY,
        committed[0]?.encryptedMetadata ?? "",
        metadataContextFromPayload(committed[0]),
      ),
    ).resolves.toEqual({
      path: "Folder/new.md",
      hash: upsertHash,
    });
    expect(uploaded[0]?.blobId).toBe(upsertBlobId);
    expect(await store.getCursor()).toBe(0);
    expect(await store.listDirtyEntries()).toEqual([]);
    expect(await store.getEntryByPath("Folder/new.md")).toEqual({
      entryId: "entry-upsert",
      path: "Folder/new.md",
      revision: 1,
      blobId: upsertBlobId,
      hash: upsertHash,
      deleted: false,
      updatedAt: expect.any(Number),
      localMtime: null,
      localSize: null,
    });
    expect(await store.getEntryById("entry-deleted")).toEqual({
      entryId: "entry-deleted",
      path: "Folder/deleted.md",
      revision: 3,
      blobId: null,
      hash: null,
      deleted: true,
      updatedAt: expect.any(Number),
      localMtime: null,
      localSize: null,
    });
    await store.close();
  });

  it("checkpoints accepted push cursors when they are contiguous with the last pull", async () => {
    const store = createTestSyncStore();
    await store.setCursor(10);
    await store.markEntryDirty({
      mutationId: "mutation-delete-a",
      entryId: "entry-a",
      op: "delete",
      baseRevision: 1,
      blobId: null,
      hash: null,
      encryptedMetadata: await encryptMutationMetadata({
        entryId: "entry-a",
        baseRevision: 1,
        op: "delete",
        blobId: null,
        path: "Folder/a.md",
      }),
      createdAt: 1,
    });
    await store.markEntryDirty({
      mutationId: "mutation-delete-b",
      entryId: "entry-b",
      op: "delete",
      baseRevision: 2,
      blobId: null,
      hash: null,
      encryptedMetadata: await encryptMutationMetadata({
        entryId: "entry-b",
        baseRevision: 2,
        op: "delete",
        blobId: null,
        path: "Folder/b.md",
      }),
      createdAt: 2,
    });

    const cursors = [11, 12];
    const session = createPushSession(async (mutation) => ({
      cursor: cursors.shift() ?? 0,
      entryId: mutation.entryId,
      revision: mutation.baseRevision + 1,
    }));
    const service = new SyncPushService({
      contentRuntime: createTestContentRuntime(),
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      fileReader: {
        async readBytes() {
          throw new Error("delete mutations should not read bytes");
        },
      },
      blobClient: unusedBlobClient,
      onProgress: ignoreProgress,
    });

    await expect(service.pushPendingMutations(session)).resolves.toEqual({
      cursor: 12,
      mutationsPushed: 2,
      mutationsRequeued: 0,
      filesCreatedOrUpdated: 0,
      filesDeleted: 2,
      conflictsCreated: 0,
      shouldPullAfterPush: false,
      hasMore: false,
    });
    expect(await store.getCursor()).toBe(12);
    await store.close();
  });

  it("keeps accepted push cursors out of the checkpoint when they leave a gap", async () => {
    const store = createTestSyncStore();
    await store.setCursor(10);
    await store.markEntryDirty({
      mutationId: "mutation-delete-gap",
      entryId: "entry-gap",
      op: "delete",
      baseRevision: 1,
      blobId: null,
      hash: null,
      encryptedMetadata: await encryptMutationMetadata({
        entryId: "entry-gap",
        baseRevision: 1,
        op: "delete",
        blobId: null,
        path: "Folder/gap.md",
      }),
      createdAt: 1,
    });

    const session = createPushSession(async (mutation) => ({
      cursor: 12,
      entryId: mutation.entryId,
      revision: mutation.baseRevision + 1,
    }));
    const service = new SyncPushService({
      contentRuntime: createTestContentRuntime(),
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      fileReader: {
        async readBytes() {
          throw new Error("delete mutations should not read bytes");
        },
      },
      blobClient: unusedBlobClient,
      onProgress: ignoreProgress,
    });

    await expect(service.pushPendingMutations(session)).resolves.toEqual({
      cursor: 12,
      mutationsPushed: 1,
      mutationsRequeued: 0,
      filesCreatedOrUpdated: 0,
      filesDeleted: 1,
      conflictsCreated: 0,
      shouldPullAfterPush: true,
      hasMore: false,
    });
    expect(await store.getCursor()).toBe(10);
    await store.close();
  });

  it("returns without using the realtime session when the queue is empty", async () => {
    const store = createTestSyncStore();
    let committed = false;
    const session = createPushSession(async () => {
      committed = true;
      throw new Error("should not commit");
    });
    const service = new SyncPushService({
      contentRuntime: createTestContentRuntime(),
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      fileReader: {
        async readBytes() {
          throw new Error("should not read bytes");
        },
      },
      blobClient: unusedBlobClient,
      onProgress: ignoreProgress,
    });

    await expect(service.pushPendingMutations(session)).resolves.toEqual({
      cursor: 0,
      mutationsPushed: 0,
      mutationsRequeued: 0,
      filesCreatedOrUpdated: 0,
      filesDeleted: 0,
      conflictsCreated: 0,
      shouldPullAfterPush: false,
      hasMore: false,
    });
    expect(committed).toBe(false);
    await store.close();
  });

});
