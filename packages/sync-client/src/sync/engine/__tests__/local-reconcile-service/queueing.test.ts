import { describe, expect, it } from "vitest";

import { encodeUtf8, hashBytes } from "../../../core/content";
import { createTestSyncStore } from "../../../../test-support/in-memory-sync-store";
import { SyncEventRecorder } from "../../event-recorder";
import { SyncLocalReconcileService } from "../../local-reconcile-service";
import {
  decryptPendingMetadata,
  encryptTestMetadata,
  localFile,
  putTestBaseBlob,
  TEST_VAULT_KEY,
} from "./helpers";

describe("SyncLocalReconcileService queueing", () => {
  it("queues new files and server-backed deletes from a local snapshot", async () => {
    const store = createTestSyncStore();
    await store.upsertEntry({
      entryId: "entry-deleted",
      path: "Folder/deleted.md",
      revision: 2,
      blobId: "blob-old",
      hash: "old-hash",
      deleted: false,
      updatedAt: 1,
    });

    const service = new SyncLocalReconcileService({
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      shouldSyncPath: () => true,
      scanner: {
        async listFiles() {
          return [
            localFile("Folder/new.md", encodeUtf8("new body")),
          ];
        },
      },
    });

    const result = await service.reconcileOnce();

    expect(result).toEqual({
      filesScanned: 1,
      filesQueuedForUpsert: 1,
      filesQueuedForDelete: 1,
    });

    const pending = await store.listDirtyEntries();
    expect(pending).toHaveLength(2);
    expect(pending.map((item) => item.op).sort()).toEqual(["delete", "upsert"]);
    const upsertMutation = pending.find((item) => item.op === "upsert");
    await expect(
      decryptPendingMetadata(upsertMutation),
    ).resolves.toEqual({
      path: "Folder/new.md",
      hash: await hashBytes(encodeUtf8("new body")),
    });
    expect(upsertMutation?.blobId).toEqual(expect.any(String));
    expect(upsertMutation?.hash).toBe(await hashBytes(encodeUtf8("new body")));
    const deleteMutation = pending.find((item) => item.op === "delete");
    await expect(
      decryptPendingMetadata(deleteMutation),
    ).resolves.toEqual({
      path: "Folder/deleted.md",
      hash: null,
    });
    expect(await store.getEntryById("entry-deleted")).toEqual({
      entryId: "entry-deleted",
      path: null,
      revision: 2,
      blobId: null,
      hash: null,
      deleted: true,
      updatedAt: expect.any(Number),
      localMtime: null,
      localSize: null,
    });
    await store.close();
  });

  it("reuses the same entry id when a file was renamed with identical content", async () => {
    const store = createTestSyncStore();
    const hash = await hashBytes(encodeUtf8("same body"));
    await store.upsertEntry({
      entryId: "entry-rename",
      path: "Old/name.md",
      revision: 4,
      blobId: "blob-rename",
      hash,
      deleted: false,
      updatedAt: 1,
    });
    await putTestBaseBlob(store, {
      blobId: "blob-rename",
      hash,
      bytes: encodeUtf8("same body"),
    });

    const service = new SyncLocalReconcileService({
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      shouldSyncPath: () => true,
      scanner: {
        async listFiles() {
          return [
            localFile("New/name.md", encodeUtf8("same body")),
          ];
        },
      },
    });

    const result = await service.reconcileOnce();

    expect(result).toEqual({
      filesScanned: 1,
      filesQueuedForUpsert: 1,
      filesQueuedForDelete: 0,
    });
    const pending = await store.listDirtyEntries();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      mutationId: expect.any(String),
      entryId: "entry-rename",
      op: "upsert",
      baseRevision: 4,
      blobId: expect.any(String),
      hash,
      encryptedMetadata: expect.any(String),
      createdAt: expect.any(Number),
    });
    await expect(
      decryptPendingMetadata(pending[0]),
    ).resolves.toEqual({
      path: "New/name.md",
      hash,
    });
    await store.close();
  });

  it("does not reconcile a new file onto an entry renamed locally", async () => {
    const store = createTestSyncStore();
    const oldPath = "Old/name.md";
    const nextPath = "New/name.md";
    const renamedBytes = encodeUtf8("renamed body");
    const renamedHash = await hashBytes(renamedBytes);
    const newBytes = encodeUtf8("new body at old path");
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
    const recorder = new SyncEventRecorder({
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
    });
    await recorder.recordRename(oldPath, nextPath, renamedBytes);

    const service = new SyncLocalReconcileService({
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      shouldSyncPath: () => true,
      scanner: {
        async listFiles() {
          return [
            localFile(oldPath, newBytes),
            localFile(nextPath, renamedBytes),
          ];
        },
      },
    });

    const result = await service.reconcileOnce();

    expect(result).toEqual({
      filesScanned: 2,
      filesQueuedForUpsert: 1,
      filesQueuedForDelete: 0,
    });
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

  it("reuses existing remote blob ids for binary renames", async () => {
    const store = createTestSyncStore();
    const imageBytes = new Uint8Array([9, 8, 7, 6, 5]);
    const imageHash = await hashBytes(imageBytes);
    await store.upsertEntry({
      entryId: "entry-image",
      path: "Assets/old.png",
      revision: 3,
      blobId: "blob-image",
      hash: imageHash,
      deleted: false,
      updatedAt: 1,
    });

    const service = new SyncLocalReconcileService({
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      shouldSyncPath: () => true,
      scanner: {
        async listFiles() {
          return [
            localFile("Assets/new.png", imageBytes),
          ];
        },
      },
    });

    const result = await service.reconcileOnce();

    expect(result).toEqual({
      filesScanned: 1,
      filesQueuedForUpsert: 1,
      filesQueuedForDelete: 0,
    });
    const pending = await store.listDirtyEntries();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      mutationId: expect.any(String),
      entryId: "entry-image",
      op: "upsert",
      baseRevision: 3,
      blobId: "blob-image",
      hash: imageHash,
      encryptedMetadata: expect.any(String),
      createdAt: expect.any(Number),
    });
    await expect(
      decryptPendingMetadata(pending[0]),
    ).resolves.toEqual({
      path: "Assets/new.png",
      hash: imageHash,
    });

    await store.close();
  });

  it("preserves pending upsert mutations for files matching the local snapshot", async () => {
    const store = createTestSyncStore();
    const bytes = encodeUtf8("same body");
    const hash = await hashBytes(bytes);
    await store.upsertEntry({
      entryId: "entry-synced",
      path: "Notes/synced.md",
      revision: 7,
      blobId: "blob-synced",
      hash,
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: null,
    });
    await store.markEntryDirty({
      mutationId: "mutation-pending",
      entryId: "entry-synced",
      op: "upsert",
      baseRevision: 7,
      blobId: "blob-synced",
      hash,
      encryptedMetadata: await encryptTestMetadata({
        entryId: "entry-synced",
        revision: 8,
        op: "upsert",
        blobId: "blob-synced",
        path: "Notes/synced.md",
        hash,
      }),
      createdAt: 2,
    });

    const service = new SyncLocalReconcileService({
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      shouldSyncPath: () => true,
      scanner: {
        async listFiles() {
          return [
            localFile("Notes/synced.md", bytes),
          ];
        },
      },
    });

    const result = await service.reconcileOnce();

    expect(result).toEqual({
      filesScanned: 1,
      filesQueuedForUpsert: 0,
      filesQueuedForDelete: 0,
    });
    expect(await store.listDirtyEntries()).toHaveLength(1);
    expect(await store.getDirtyEntryMutation("entry-synced")).toMatchObject({
      mutationId: "mutation-pending",
      entryId: "entry-synced",
      op: "upsert",
      baseRevision: 7,
      blobId: "blob-synced",
      hash,
    });
    expect(await store.getEntryByPath("Notes/synced.md")).toMatchObject({
      entryId: "entry-synced",
      revision: 7,
      blobId: "blob-synced",
      hash,
      localMtime: 10,
      localSize: bytes.byteLength,
    });
    await store.close();
  });

  it("replaces a pending delete when the file is restored before push", async () => {
    const store = createTestSyncStore();
    const bytes = encodeUtf8("same body");
    const hash = await hashBytes(bytes);
    await store.upsertEntry({
      entryId: "entry-restored",
      path: "Notes/restored.md",
      revision: 3,
      blobId: "blob-restored",
      hash,
      deleted: false,
      updatedAt: 1,
      localMtime: 10,
      localSize: bytes.byteLength,
    });
    await putTestBaseBlob(store, {
      blobId: "blob-restored",
      hash,
      bytes,
    });

    let files = [] as ReturnType<typeof localFile>[];
    const service = new SyncLocalReconcileService({
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      shouldSyncPath: () => true,
      scanner: {
        async listFiles() {
          return files;
        },
      },
    });

    await expect(service.reconcileOnce()).resolves.toEqual({
      filesScanned: 0,
      filesQueuedForUpsert: 0,
      filesQueuedForDelete: 1,
    });
    expect(await store.getEntryById("entry-restored")).toMatchObject({
      entryId: "entry-restored",
      path: null,
      revision: 3,
      blobId: null,
      hash: null,
      deleted: true,
      localMtime: null,
      localSize: null,
    });

    files = [localFile("Notes/restored.md", bytes)];

    await expect(service.reconcileOnce()).resolves.toEqual({
      filesScanned: 1,
      filesQueuedForUpsert: 1,
      filesQueuedForDelete: 0,
    });

    const pending = await store.listDirtyEntries();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      entryId: "entry-restored",
      op: "upsert",
      baseRevision: 3,
      hash,
    });
    await expect(decryptPendingMetadata(pending[0])).resolves.toEqual({
      path: "Notes/restored.md",
      hash,
    });
    expect(await store.getEntryByPath("Notes/restored.md")).toMatchObject({
      entryId: "entry-restored",
      revision: 3,
      hash,
      deleted: false,
      localMtime: 10,
      localSize: bytes.byteLength,
    });
    await store.close();
  });

  it("reads files concurrently while applying queued mutations in scan order", async () => {
    const store = createTestSyncStore();
    const appliedPaths: Array<string | null> = [];
    const observedStore = new Proxy(store, {
      get(target, property, receiver) {
        if (property === "applyReconcileEntryUpdates") {
          return async (
            updates: Parameters<typeof store.applyReconcileEntryUpdates>[0],
          ) => {
            appliedPaths.push(
              ...updates
                .filter((update) => update.local)
                .map((update) => update.local?.path ?? null),
            );
            await store.applyReconcileEntryUpdates(updates);
          };
        }

        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const bodies = ["first", "second", "third"].map(encodeUtf8);
    const readsStarted: string[] = [];
    const deferredReads = new Map<string, Deferred<Uint8Array>>();
    const files = bodies.map((bytes, index) => {
      const path = `Notes/file-${index}.md`;
      const deferred = createDeferred<Uint8Array>();
      deferredReads.set(path, deferred);
      return {
        path,
        mtime: 10,
        size: bytes.byteLength,
        async readBytes() {
          readsStarted.push(path);
          return await deferred.promise;
        },
      };
    });

    const service = new SyncLocalReconcileService({
      getSyncStore: () => observedStore,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      hashConcurrency: 2,
      shouldSyncPath: () => true,
      scanner: {
        async listFiles() {
          return files;
        },
      },
    });

    const reconcilePromise = service.reconcileOnce();
    await waitFor(() => readsStarted.length === 2);
    expect(readsStarted).toEqual(["Notes/file-0.md", "Notes/file-1.md"]);

    deferredReads.get("Notes/file-1.md")?.resolve(bodies[1]);
    await waitFor(() => readsStarted.length === 3);
    expect(await store.listDirtyEntries()).toEqual([]);

    deferredReads.get("Notes/file-2.md")?.resolve(bodies[2]);
    deferredReads.get("Notes/file-0.md")?.resolve(bodies[0]);

    await expect(reconcilePromise).resolves.toEqual({
      filesScanned: 3,
      filesQueuedForUpsert: 3,
      filesQueuedForDelete: 0,
    });
    expect(appliedPaths).toEqual([
      "Notes/file-0.md",
      "Notes/file-1.md",
      "Notes/file-2.md",
    ]);

    const pending = await store.listDirtyEntries();
    const metadata = await Promise.all(pending.map(decryptPendingMetadata));
    expect([...metadata].sort((left, right) => left.path.localeCompare(right.path))).toEqual([
      {
        path: "Notes/file-0.md",
        hash: await hashBytes(bodies[0]),
      },
      {
        path: "Notes/file-1.md",
        hash: await hashBytes(bodies[1]),
      },
      {
        path: "Notes/file-2.md",
        hash: await hashBytes(bodies[2]),
      },
    ]);
    await store.close();
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

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
