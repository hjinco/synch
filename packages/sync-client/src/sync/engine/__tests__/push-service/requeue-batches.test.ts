import { describe, expect, it } from "vitest";

import { encodeUtf8, hashBytes } from "../../../core/content";
import { decryptSyncBlob } from "../../../core/crypto";
import type { CommitMutationPayload } from "../../../remote/realtime-client";
import { SyncRealtimeError } from "../../../remote/realtime-client";
import { createTestSyncStore } from "../../../../test-support/in-memory-sync-store";
import { SyncEventRecorder } from "../../event-recorder";
import { SyncPushService } from "../../push-service";
import {
  createPushSession,
  createToken,
  encryptMutationMetadata,
  ignoreProgress,
  putTestBaseBlob,
  TEST_VAULT_KEY,
  unusedBlobClient,
} from "./helpers";

describe("SyncPushService requeue and batches", () => {
  it("rebases a newer local edit that lands while an older push is being accepted", async () => {
    const store = createTestSyncStore();
    const path = "Folder/note.md";
    const baseHash = await hashBytes(encodeUtf8("base body"));
    const pushedHash = await hashBytes(encodeUtf8("pushed body"));
    const newerHash = await hashBytes(encodeUtf8("newer body"));
    await store.upsertEntry({
      entryId: "entry-note",
      path,
      revision: 1,
      blobId: "blob-base",
      hash: baseHash,
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: null,
    });
    await putTestBaseBlob(store, {
      blobId: "blob-base",
      hash: baseHash,
      bytes: encodeUtf8("base body"),
    });

    const recorder = new SyncEventRecorder({
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
    });
    await recorder.recordUpsert(path, encodeUtf8("pushed body"));

    let currentBody = "pushed body";
    let firstCommitAccepted = false;
    let nextCursor = 0;
    const committed: CommitMutationPayload[] = [];
    const session = createPushSession(async (mutation) => {
      committed.push(mutation);
      if (mutation.baseRevision !== committed.length) {
        throw new SyncRealtimeError("stale_revision", "stale revision");
      }

      if (!firstCommitAccepted) {
        firstCommitAccepted = true;
        currentBody = "newer body";
        await recorder.recordUpsert(path, encodeUtf8("newer body"));
      }

      nextCursor += 1;
      return {
        cursor: nextCursor,
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
        async readBytes(readPath) {
          expect(readPath).toBe(path);
          return encodeUtf8(currentBody);
        },
      },
      blobClient: {
        async uploadBlob() {},
      },
      onProgress: ignoreProgress,
    });

    const result = await service.pushPendingMutations(session);

    expect(result.conflictsCreated).toBe(0);
    expect(result.mutationsPushed).toBe(2);
    expect(committed.map((mutation) => mutation.baseRevision)).toEqual([1, 2]);
    expect(committed[0]?.blobId).not.toBe(committed[1]?.blobId);
    expect(await store.listDirtyEntries()).toEqual([]);
    expect(await store.getRemoteStateById("entry-note")).toMatchObject({
      revision: 3,
      hash: newerHash,
    });
    expect(await store.getLocalStateById("entry-note")).toMatchObject({
      path,
      hash: newerHash,
    });
    expect(await store.getEntryById("entry-note")).toMatchObject({
      revision: 3,
      hash: newerHash,
    });
    expect(pushedHash).not.toBe(newerHash);
    await store.close();
  });

  it("preserves a newer same-content rename while an older push is being accepted", async () => {
    const store = createTestSyncStore();
    const oldPath = "Folder/note.md";
    const nextPath = "Folder/renamed.md";
    const baseHash = await hashBytes(encodeUtf8("base body"));
    const body = encodeUtf8("same body");
    const hash = await hashBytes(body);
    await store.upsertEntry({
      entryId: "entry-note",
      path: oldPath,
      revision: 1,
      blobId: "blob-base",
      hash: baseHash,
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: null,
    });
    await putTestBaseBlob(store, {
      blobId: "blob-base",
      hash: baseHash,
      bytes: encodeUtf8("base body"),
    });

    const recorder = new SyncEventRecorder({
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
    });
    await recorder.recordUpsert(oldPath, body);

    let currentPath = oldPath;
    let firstCommitAccepted = false;
    let nextCursor = 0;
    const committed: CommitMutationPayload[] = [];
    const session = createPushSession(async (mutation) => {
      committed.push(mutation);
      if (!firstCommitAccepted) {
        firstCommitAccepted = true;
        currentPath = nextPath;
        await recorder.recordRename(oldPath, nextPath, body);
      }

      nextCursor += 1;
      return {
        cursor: nextCursor,
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
        async readBytes(readPath) {
          expect(readPath).toBe(currentPath);
          return body;
        },
      },
      blobClient: {
        async uploadBlob() {},
      },
      onProgress: ignoreProgress,
    });

    const result = await service.pushPendingMutations(session);

    expect(result.conflictsCreated).toBe(0);
    expect(result.mutationsPushed).toBe(2);
    expect(committed.map((mutation) => mutation.baseRevision)).toEqual([1, 2]);
    expect(await store.listDirtyEntries()).toEqual([]);
    expect(await store.getRemoteStateById("entry-note")).toMatchObject({
      path: nextPath,
      revision: 3,
      hash,
    });
    expect(await store.getLocalStateById("entry-note")).toMatchObject({
      path: nextPath,
      hash,
    });
    await store.close();
  });

  it("pushes a changed upsert after requeueing it in the same drain", async () => {
    const store = createTestSyncStore();
    const staleHash = await hashBytes(encodeUtf8("stale body"));
    const currentHash = await hashBytes(encodeUtf8("current body"));
    await store.upsertEntry({
      entryId: "entry-note",
      path: "Folder/note.md",
      revision: 0,
      blobId: "blob-stale",
      hash: staleHash,
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: null,
    });
    await store.markEntryDirty({
      mutationId: "mutation-stale",
      entryId: "entry-note",
      op: "upsert",
      baseRevision: 0,
      blobId: "blob-stale",
      hash: staleHash,
      encryptedMetadata: await encryptMutationMetadata({
        entryId: "entry-note",
        baseRevision: 0,
        op: "upsert",
        blobId: "blob-stale",
        path: "Folder/note.md",
        hash: staleHash,
      }),
      createdAt: 1,
    });

    const committed: Array<CommitMutationPayload> = [];
    const uploaded: Array<{ blobId: string; bytes: Uint8Array }> = [];
    let nextCursor = 0;
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
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      fileReader: {
        async readBytes(path) {
          expect(path).toBe("Folder/note.md");
          return new TextEncoder().encode("current body");
        },
      },
      blobClient: {
        async uploadBlob(_apiBaseUrl, _syncToken, _vaultId, blobId, bytes) {
          uploaded.push({
            blobId,
            bytes,
          });
        },
      },
      onProgress: ignoreProgress,
    });

    const result = await service.pushPendingMutations(session);

    expect(result).toEqual({
      cursor: 1,
      mutationsPushed: 1,
      mutationsRequeued: 1,
      filesCreatedOrUpdated: 1,
      filesDeleted: 0,
      conflictsCreated: 0,
      shouldPullAfterPush: false,
      hasMore: false,
    });
    expect(committed).toHaveLength(1);
    expect(committed[0]?.mutationId).not.toBe("mutation-stale");
    expect(committed[0]?.blobId).not.toBe("blob-stale");
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]?.blobId).toBe(committed[0]?.blobId);
    expect(await store.getCursor()).toBe(1);
    await expect(
      decryptSyncBlob(TEST_VAULT_KEY, uploaded[0]?.bytes ?? new Uint8Array(), {
        blobId: uploaded[0]?.blobId ?? "",
      }),
    ).resolves.toEqual(new TextEncoder().encode("current body"));
    expect(await store.listDirtyEntries()).toEqual([]);
    expect(await store.getEntryByPath("Folder/note.md")).toEqual({
      entryId: "entry-note",
      path: "Folder/note.md",
      revision: 1,
      blobId: committed[0]?.blobId,
      hash: currentHash,
      deleted: false,
      updatedAt: expect.any(Number),
      localMtime: null,
      localSize: null,
    });
    await store.close();
  });

  it("drains pending mutations across multiple batches", async () => {
    const store = createTestSyncStore();
    const mutationCount = 125;
    for (let index = 0; index < mutationCount; index += 1) {
      await store.markEntryDirty({
        mutationId: `mutation-delete-${index}`,
        entryId: `entry-delete-${index}`,
        op: "delete",
        baseRevision: 1,
        blobId: null,
        hash: null,
        encryptedMetadata: await encryptMutationMetadata({
          entryId: `entry-delete-${index}`,
          baseRevision: 1,
          op: "delete",
          blobId: null,
          path: `Folder/deleted-${index}.md`,
        }),
        createdAt: index,
      });
    }

    const committed: Array<CommitMutationPayload> = [];
    const batchRequests: CommitMutationPayload[][] = [];
    const session = createPushSession(
      async () => {
        throw new Error("push service should commit prepared mutations in batches");
      },
      async (mutations) => {
        batchRequests.push(mutations);
        const results = mutations.map((mutation) => {
          committed.push(mutation);
          return {
            status: "accepted" as const,
            mutationId: mutation.mutationId,
            cursor: committed.length,
            entryId: mutation.entryId,
            revision: mutation.baseRevision + 1,
          };
        });
        return {
          cursor: committed.length,
          results,
        };
      },
    );
    const service = new SyncPushService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
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

    const result = await service.pushPendingMutations(session);

    expect(result).toEqual({
      cursor: 125,
      mutationsPushed: 125,
      mutationsRequeued: 0,
      filesCreatedOrUpdated: 0,
      filesDeleted: 125,
      conflictsCreated: 0,
      shouldPullAfterPush: false,
      hasMore: false,
    });
    expect(batchRequests.every((batch) => batch.length > 0 && batch.length <= 100)).toBe(true);
    expect(batchRequests.some((batch) => batch.length > 1)).toBe(true);
    expect(committed).toHaveLength(125);
    expect(committed[0]?.entryId).toBe("entry-delete-0");
    expect(committed[committed.length - 1]?.entryId).toBe("entry-delete-124");
    expect(await store.listDirtyEntries()).toEqual([]);
    expect(await store.getCursor()).toBe(125);

    await store.close();
  });
});
