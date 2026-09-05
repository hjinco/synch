import { describe, expect, it } from "vitest";

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
  it("counts only selected mutations and preserves pending work after the drain limit", async () => {
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

    expect(result.mutationsPushed).toBe(1_000);
    expect(result.hasMore).toBe(true);
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

  it("prepares blob uploads concurrently while committing in queue order", async () => {
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
    const session = createPushSession(async (mutation) => {
      committed.push(mutation);
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
    expect(committed).toEqual([]);

    uploadDeferreds.get("blob-2")?.resolve();
    uploadDeferreds.get("blob-0")?.resolve();
    await pushPromise;

    expect(committed.map((mutation) => mutation.blobId)).toEqual(["blob-0", "blob-1", "blob-2"]);
    expect(maxActiveUploads).toBe(2);
    expect(await store.listDirtyEntries()).toEqual([]);
    await store.close();
  });

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
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error("condition was not met");
}
