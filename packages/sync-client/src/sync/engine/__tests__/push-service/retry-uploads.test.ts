import { describe, expect, it } from "vitest";

import { encodeUtf8, hashBytes } from "../../../core/content";
import { SyncRealtimeError } from "../../../remote/realtime-client";
import { createTestSyncStore } from "../../../../test-support/in-memory-sync-store";
import { SyncPushService } from "../../push-service";
import type { SyncStore } from "../../../store/store";
import {
  createPushSession,
  createToken,
  encryptMutationMetadata,
  ignoreProgress,
  TEST_VAULT_KEY,
} from "./helpers";

describe("SyncPushService retry uploads", () => {
  it("does not re-upload a blob after a failed commit", async () => {
    const { store, hash, blobId, bytes } = await arrangePendingUpsert();
    const uploadedBlobIds: string[] = [];
    let failCommit = true;
    const session = createPushSession(async (mutation) => {
      if (failCommit) {
        failCommit = false;
        throw new Error("socket closed");
      }
      return {
        cursor: 1,
        entryId: mutation.entryId,
        revision: mutation.baseRevision + 1,
      };
    });
    const service = createRetryUploadService(
      store,
      { "Folder/note.md": bytes },
      uploadedBlobIds,
    );

    await expect(service.pushPendingMutations(session)).rejects.toThrow("socket closed");
    expect(uploadedBlobIds).toEqual([blobId]);

    await expect(service.pushPendingMutations(session)).resolves.toMatchObject({
      mutationsPushed: 1,
      filesCreatedOrUpdated: 1,
    });
    expect(uploadedBlobIds).toEqual([blobId]);
    expect(await store.listDirtyEntries()).toEqual([]);
    expect(await store.getEntryById("entry-note")).toMatchObject({
      blobId,
      hash,
      revision: 1,
    });

    await store.close();
  });

  it("re-uploads after the server reports the blob is missing", async () => {
    const { store, blobId, bytes } = await arrangePendingUpsert();
    const uploadedBlobIds: string[] = [];
    let rejectAsMissing = true;
    const session = createPushSession(async (mutation) => {
      if (rejectAsMissing) {
        rejectAsMissing = false;
        throw new SyncRealtimeError(
          "blob_not_staged",
          `blob ${mutation.blobId} was not staged`,
        );
      }
      return {
        cursor: 1,
        entryId: mutation.entryId,
        revision: mutation.baseRevision + 1,
      };
    });
    const service = createRetryUploadService(
      store,
      { "Folder/note.md": bytes },
      uploadedBlobIds,
    );

    await expect(service.pushPendingMutations(session)).rejects.toMatchObject({
      code: "blob_not_staged",
    });
    expect(uploadedBlobIds).toEqual([blobId]);

    await expect(service.pushPendingMutations(session)).resolves.toMatchObject({
      mutationsPushed: 1,
    });
    expect(uploadedBlobIds).toEqual([blobId, blobId]);

    await store.close();
  });

  it("re-uploads every blob after a batch reports them missing", async () => {
    const store = createTestSyncStore();
    const note = await arrangePendingUpsert(store, {
      entryId: "entry-note",
      mutationId: "mutation-note",
      blobId: "blob-note",
      path: "Folder/note.md",
      body: "note body",
    });
    const task = await arrangePendingUpsert(store, {
      entryId: "entry-task",
      mutationId: "mutation-task",
      blobId: "blob-task",
      path: "Folder/task.md",
      body: "task body",
    });
    const uploadedBlobIds: string[] = [];
    let rejectAsMissing = true;
    const session = createPushSession(async (mutation) => {
      if (rejectAsMissing) {
        throw new SyncRealtimeError(
          "blob_not_staged",
          `blob ${mutation.blobId} was not staged`,
        );
      }
      return {
        cursor: mutation.entryId === "entry-note" ? 1 : 2,
        entryId: mutation.entryId,
        revision: mutation.baseRevision + 1,
      };
    });
    const service = createRetryUploadService(
      store,
      {
        "Folder/note.md": note.bytes,
        "Folder/task.md": task.bytes,
      },
      uploadedBlobIds,
    );

    await expect(service.pushPendingMutations(session)).rejects.toMatchObject({
      code: "blob_not_staged",
    });
    expect(uploadedBlobIds).toHaveLength(2);
    expect(new Set(uploadedBlobIds)).toEqual(new Set([note.blobId, task.blobId]));

    rejectAsMissing = false;
    await expect(service.pushPendingMutations(session)).resolves.toMatchObject({
      mutationsPushed: 2,
    });
    expect(uploadedBlobIds.filter((blobId) => blobId === note.blobId)).toHaveLength(2);
    expect(uploadedBlobIds.filter((blobId) => blobId === task.blobId)).toHaveLength(2);

    await store.close();
  });
});

async function arrangePendingUpsert(
  store: SyncStore = createTestSyncStore(),
  file: {
    entryId: string;
    mutationId: string;
    blobId: string;
    path: string;
    body: string;
  } = {
    entryId: "entry-note",
    mutationId: "mutation-note",
    blobId: "blob-note",
    path: "Folder/note.md",
    body: "note body",
  },
) {
  const bytes = encodeUtf8(file.body);
  const hash = await hashBytes(bytes);
  await store.markEntryDirty({
    mutationId: file.mutationId,
    entryId: file.entryId,
    op: "upsert",
    baseRevision: 0,
    blobId: file.blobId,
    hash,
    encryptedMetadata: await encryptMutationMetadata({
      entryId: file.entryId,
      baseRevision: 0,
      op: "upsert",
      blobId: file.blobId,
      path: file.path,
      hash,
    }),
    createdAt: 1,
  });
  return { store, bytes, hash, blobId: file.blobId };
}

function createRetryUploadService(
  store: SyncStore,
  files: Record<string, Uint8Array>,
  uploadedBlobIds: string[],
) {
  return new SyncPushService({
    getApiBaseUrl: () => "http://127.0.0.1:8787",
    getSyncToken: async () => createToken(),
    getSyncStore: () => store,
    getRemoteVaultKey: () => TEST_VAULT_KEY,
    fileReader: {
      async readBytes(path) {
        const bytes = files[path];
        if (bytes) {
          return bytes;
        }
        throw new Error(`unexpected read for ${path}`);
      },
    },
    blobClient: {
      async uploadBlob(_apiBaseUrl, _syncToken, _vaultId, blobId) {
        uploadedBlobIds.push(blobId);
      },
    },
    onProgress: ignoreProgress,
  });
}
