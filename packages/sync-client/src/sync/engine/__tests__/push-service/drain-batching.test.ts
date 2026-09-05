import { describe, expect, it, vi } from "vitest";

import { encodeUtf8, hashBytes } from "../../../core/content";
import {
  SyncRealtimeError,
  type CommitMutationPayload,
} from "../../../remote/realtime-client";
import { createTestSyncStore } from "../../../../test-support/in-memory-sync-store";
import { SyncPushService } from "../../push-service";
import {
  createPushSession,
  createToken,
  encryptMutationMetadata,
  ignoreProgress,
  TEST_VAULT_KEY,
  unusedBlobClient,
} from "./helpers";

describe("SyncPushService drain: batching", () => {
  it("drains more than 1000 mutations and reports all completed work", async () => {
    const store = createTestSyncStore();
    const mutationCount = 1_001;
    const body = new TextEncoder().encode("body");
    const hash = await hashBytes(body);
    for (let index = 0; index < mutationCount; index += 1) {
      await store.markEntryDirty({
        mutationId: `mutation-upsert-${index}`,
        entryId: `entry-upsert-${index}`,
        op: "upsert",
        baseRevision: 0,
        blobId: `blob-upsert-${index}`,
        hash,
        encryptedMetadata: await encryptMutationMetadata({
          entryId: `entry-upsert-${index}`,
          baseRevision: 0,
          op: "upsert",
          blobId: `blob-upsert-${index}`,
          path: `Folder/file-${index}.md`,
          hash,
        }),
        createdAt: index,
      });
    }

    const progressUpdates: Array<{ completedEntries: number; totalEntries: number }> = [];
    const session = createPushSession(async (mutation) => ({
      cursor: Number(mutation.mutationId.replace("mutation-upsert-", "")) + 1,
      entryId: mutation.entryId,
      revision: mutation.baseRevision + 1,
    }));
    const service = new SyncPushService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      fileReader: {
        async readBytes() {
          return body;
        },
      },
      blobClient: {
        async uploadBlob() {},
      },
      onProgress: async (progress) => {
        progressUpdates.push(progress);
      },
    });

    const result = await service.pushPendingMutations(session);

    expect(result.mutationsPushed).toBe(mutationCount);
    expect(result.hasMore).toBe(false);
    expect(progressUpdates[0]).toEqual({
      direction: "push", totalKnown: false,
      completedEntries: 0,
      totalEntries: 0,
    });
    expect(progressUpdates[progressUpdates.length - 1]).toEqual({
      direction: "push", totalKnown: true,
      completedEntries: result.mutationsPushed,
      totalEntries: result.mutationsPushed,
    });
    await store.close();
  });

  it("applies ready files before a slow upload while bounding upload concurrency", async () => {
    const store = createTestSyncStore();
    const bodies = ["first body", "second body", "third body"];
    for (let index = 0; index < bodies.length; index += 1) {
      const hash = await hashBytes(encodeUtf8(bodies[index]));
      await store.markEntryDirty({
        mutationId: `mutation-${index}`,
        entryId: `entry-${index}`,
        op: "upsert",
        baseRevision: 0,
        blobId: `blob-${index}`,
        hash,
        encryptedMetadata: await encryptMutationMetadata({
          entryId: `entry-${index}`,
          baseRevision: 0,
          op: "upsert",
          blobId: `blob-${index}`,
          path: `Folder/file-${index}.md`,
          hash,
        }),
        createdAt: index,
      });
    }

    const committed: Array<CommitMutationPayload> = [];
    const uploadStarts: string[] = [];
    const uploadDeferreds = new Map<string, Deferred<void>>();
    let activeUploads = 0;
    let maxActiveUploads = 0;
    const firstCommit = createDeferred<void>();
    const session = createPushSession(async (mutation) => {
      committed.push(mutation);
      if (committed.length === 1) await firstCommit.promise;
      return {
        cursor: committed.length,
        entryId: mutation.entryId,
        revision: mutation.baseRevision + 1,
      };
    });
    const service = new SyncPushService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      prepareConcurrency: 2,
      fileReader: {
        async readBytes(path) {
          const match = /^Folder\/file-(\d+)\.md$/.exec(path);
          if (!match) {
            throw new Error(`unexpected read for ${path}`);
          }

          return new TextEncoder().encode(bodies[Number(match[1])]);
        },
      },
      blobClient: {
        async uploadBlob(_apiBaseUrl, _syncToken, _vaultId, blobId) {
          uploadStarts.push(blobId);
          const deferred = createDeferred<void>();
          uploadDeferreds.set(blobId, deferred);
          activeUploads += 1;
          maxActiveUploads = Math.max(maxActiveUploads, activeUploads);
          try {
            await deferred.promise;
          } finally {
            activeUploads -= 1;
          }
        },
      },
      onProgress: ignoreProgress,
    });

    const pushPromise = service.pushPendingMutations(session);
    await waitFor(() => uploadStarts.length === 2);
    expect(uploadStarts).toHaveLength(2);
    expect(new Set(uploadStarts)).toEqual(new Set(["blob-0", "blob-1"]));
    expect(maxActiveUploads).toBe(2);

    uploadDeferreds.get("blob-1")?.resolve();
    await waitFor(() => uploadStarts.length === 3);
    await waitFor(() => committed.length === 1);
    expect(committed[0]?.blobId).toBe("blob-1");
    await waitFor(() => activeUploads === 2);

    uploadDeferreds.get("blob-2")?.resolve();
    await waitFor(() => activeUploads === 1);
    expect(committed).toHaveLength(1);
    firstCommit.resolve();
    await waitFor(() => committed.length === 2);
    uploadDeferreds.get("blob-0")?.resolve();
    await pushPromise;

    expect(committed.map((mutation) => mutation.blobId)).toEqual(["blob-1", "blob-2", "blob-0"]);
    expect(maxActiveUploads).toBe(2);
    expect(await store.listDirtyEntries()).toEqual([]);
    await store.close();
  });

  it.each(["prepare", "commit"] as const)(
    "preserves unfinished mutations and joins uploads after a %s failure",
    async (failureStage) => {
      const store = createTestSyncStore();
      const body = encodeUtf8("body");
      const hash = await hashBytes(body);
      for (let index = 0; index < 2; index++) {
        await store.markEntryDirty({
          mutationId: `mutation-${index}`,
          entryId: `entry-${index}`,
          op: "upsert",
          baseRevision: 0,
          blobId: `blob-${index}`,
          hash,
          encryptedMetadata: await encryptMutationMetadata({
            entryId: `entry-${index}`, baseRevision: 0, op: "upsert",
            blobId: `blob-${index}`, path: `file-${index}.md`, hash,
          }),
          createdAt: index,
        });
      }
      const slowUpload = createDeferred<void>();
      const expectedError = new Error("injected failure");
      let shouldFail = true;
      let commitStarted = false;
      let completed = false;
      let settled = false;
      let cursor = 0;
      const uploads: string[] = [];
      const session = createPushSession(async (mutation) => {
        commitStarted = true;
        if (shouldFail && failureStage === "commit") throw expectedError;
        return { cursor: ++cursor, entryId: mutation.entryId, revision: 1 };
      });
      const service = new SyncPushService({
        getApiBaseUrl: () => "http://127.0.0.1:8787",
        getSyncToken: async () => createToken(),
        getSyncStore: () => store,
        getRemoteVaultKey: () => TEST_VAULT_KEY,
        fileReader: { async readBytes() { return body; } },
        blobClient: {
          async uploadBlob(_url, _token, _vault, blobId) {
            uploads.push(blobId);
            if (blobId === "blob-1" && shouldFail) {
              await slowUpload.promise;
              if (failureStage === "prepare") throw expectedError;
            }
          },
        },
        onFileSyncCompleted: () => { completed = true; },
      });
      // Attach the rejection handler before releasing either operation.
      const push = service.pushPendingMutations(session).then(
        () => { settled = true; return null; },
        (error: unknown) => { settled = true; return error; },
      );
      await waitFor(() => commitStarted);
      if (failureStage === "prepare") await waitFor(() => completed);
      expect(settled).toBe(false);
      slowUpload.resolve();
      expect(await push).toBe(expectedError);
      expect((await store.listDirtyEntries()).map(({ entryId }) => entryId)).toEqual(
        failureStage === "prepare" ? ["entry-1"] : ["entry-0", "entry-1"],
      );
      shouldFail = false;
      await service.pushPendingMutations(session);
      expect(await store.listDirtyEntries()).toEqual([]);
      expect(uploads.filter((id) => id === "blob-0")).toHaveLength(1);
      expect(uploads.filter((id) => id === "blob-1")).toHaveLength(
        failureStage === "prepare" ? 2 : 1,
      );
      await store.close();
    },
  );

  it("keeps crypto context scoped to each overlapping push call", async () => {
    const firstStore = createTestSyncStore();
    const secondStore = createTestSyncStore();
    await firstStore.markEntryDirty({
      mutationId: "mutation-delete-first",
      entryId: "entry-delete-first",
      op: "delete",
      baseRevision: 1,
      blobId: null,
      hash: null,
      encryptedMetadata: await encryptMutationMetadata({
        entryId: "entry-delete-first",
        baseRevision: 1,
        op: "delete",
        blobId: null,
        path: "Folder/first.md",
      }),
      createdAt: 1,
    });
    await secondStore.markEntryDirty({
      mutationId: "mutation-delete-second",
      entryId: "entry-delete-second",
      op: "delete",
      baseRevision: 1,
      blobId: null,
      hash: null,
      encryptedMetadata: await encryptMutationMetadata({
        entryId: "entry-delete-second",
        baseRevision: 1,
        op: "delete",
        blobId: null,
        path: "Folder/second.md",
      }),
      createdAt: 1,
    });

    let currentStore = firstStore;
    const firstCommit = createDeferred<void>();
    let firstCommitStarted = false;
    const firstSession = createPushSession(async () => {
      firstCommitStarted = true;
      await firstCommit.promise;
      throw new SyncRealtimeError(
        "stale_revision",
        "expected base revision 0 but received 1",
        { expectedBaseRevision: 0, receivedBaseRevision: 1 },
      );
    });
    const secondSession = createPushSession(async () => {
      throw new SyncRealtimeError(
        "stale_revision",
        "expected base revision 0 but received 1",
        { expectedBaseRevision: 0, receivedBaseRevision: 1 },
      );
    });
    const service = new SyncPushService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => currentStore,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      fileReader: {
        async readBytes() {
          throw new Error("delete mutations should not read bytes");
        },
      },
      blobClient: unusedBlobClient,
      onProgress: ignoreProgress,
    });

    const firstPush = service.pushPendingMutations(firstSession);
    await waitFor(() => firstCommitStarted);
    currentStore = secondStore;
    await expect(service.pushPendingMutations(secondSession)).resolves.toMatchObject({
      mutationsPushed: 0,
      shouldPullAfterPush: false,
      hasMore: false,
    });

    firstCommit.resolve();
    await expect(firstPush).resolves.toMatchObject({
      mutationsPushed: 0,
      shouldPullAfterPush: false,
      hasMore: false,
    });
    expect(await firstStore.listDirtyEntries()).toEqual([]);
    expect(await secondStore.listDirtyEntries()).toEqual([]);

    await firstStore.close();
    await secondStore.close();
  });
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(condition: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(condition()).toBe(true), { timeout: 2_000, interval: 5 });
}
