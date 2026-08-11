import { describe, expect, it } from "vitest";

import { hashBytes } from "../../../core/content";
import { SyncPullService } from "../../pull-service";
import { createTestSyncStore } from "../../../../test-support/in-memory-sync-store";
import {
  arrangePendingUpsertWithCachedBase,
  createCommit,
  createPullClient,
  createRealtimeSession,
  createToken,
  createVaultAdapter,
  encryptRemoteMetadata,
  encryptTestBlob,
  hashText,
  ignoreProgress,
  TEST_VAULT_KEY,
  type PullConflictSummary,
} from "./helpers";

const conflictTimestamp = () => new Date(2026, 3, 22, 10, 11, 12).getTime();

describe("SyncPullService pending upsert rebase conflict resolution", () => {
  it("rebases clean markdown 3-way merges onto the pulled remote revision", async () => {
    const store = createTestSyncStore();
    const baseBody = "Title\n\noriginal line\n";
    const localBody = "Title\n\nlocal line\n";
    const remoteBody = "Remote title\n\noriginal line\n";
    const mergedBody = "Remote title\n\nlocal line\n";
    const baseHash = await hashText(baseBody);
    const localHash = await hashText(localBody);
    const remoteHash = await hashText(remoteBody);
    const mergedHash = await hashText(mergedBody);
    const adapter = createVaultAdapter({
      "Folder/note.md": localBody,
    });
    await arrangePendingUpsertWithCachedBase(store, {
      entryId: "entry-note",
      path: "Folder/note.md",
      baseRevision: 2,
      baseBlobId: "blob-base",
      baseHash,
      baseBytes: new TextEncoder().encode(baseBody),
      localBlobId: "blob-local",
      localHash,
      createdAt: 3,
    });

    const conflicts: PullConflictSummary[] = [];
    const session = createRealtimeSession({
      pages: [
        {
          cursor: 3,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 3,
              entryId: "entry-note",
              revision: 3,
              blobId: "blob-remote",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-note",
                revision: 3,
                blobId: "blob-remote",
                path: "Folder/note.md",
                hash: remoteHash,
              }),
            }),
          ],
        },
      ],
    });
    const client = createPullClient({
      blobs: {
        "blob-remote": await encryptTestBlob(
          "blob-remote",
          new TextEncoder().encode(remoteBody),
        ),
      },
    });

    const service = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      vaultAdapter: adapter,
      pullClient: client,
      onProgress: ignoreProgress,
      onConflict(event) {
        conflicts.push({
          entryId: event.entryId,
          reason: event.reason,
          originalPath: event.originalPath,
          conflictPath: event.conflictPath,
        });
      },
      now: conflictTimestamp,
    });

    await expect(service.pullOnce(session)).resolves.toEqual({
      cursor: 3,
      entriesApplied: 1,
      filesWritten: 1,
      filesDeleted: 0,
      conflictsCreated: 0,
    });
    expect(adapter.text("Folder/note.md")).toBe(mergedBody);
    expect(conflicts).toEqual([]);
    expect(await store.getRemoteStateById("entry-note")).toMatchObject({
      revision: 3,
      blobId: "blob-remote",
      hash: remoteHash,
    });
    expect(await store.getLocalStateById("entry-note")).toMatchObject({
      blobId: expect.any(String),
      hash: mergedHash,
    });
    expect(await store.listDirtyEntries()).toMatchObject([
      {
        entryId: "entry-note",
        op: "upsert",
        baseRevision: 3,
        baseBlobId: "blob-remote",
        baseHash: remoteHash,
        hash: mergedHash,
      },
    ]);
    expect(await store.getBlob("blob-remote")).toMatchObject({
      blobId: "blob-remote",
      hash: remoteHash,
    });

    await store.close();
  });

  it("creates a conflict copy when markdown 3-way merge has overlapping edits", async () => {
    const store = createTestSyncStore();
    const baseBody = "one\n";
    const localBody = "local\n";
    const remoteBody = "remote\n";
    const baseHash = await hashText(baseBody);
    const localHash = await hashText(localBody);
    const remoteHash = await hashText(remoteBody);
    const adapter = createVaultAdapter({
      "Folder/note.md": localBody,
    });
    await arrangePendingUpsertWithCachedBase(store, {
      entryId: "entry-note",
      path: "Folder/note.md",
      baseRevision: 2,
      baseBlobId: "blob-base",
      baseHash,
      baseBytes: new TextEncoder().encode(baseBody),
      localBlobId: "blob-local",
      localHash,
      createdAt: 3,
    });

    const conflicts: PullConflictSummary[] = [];
    const session = createRealtimeSession({
      pages: [
        {
          cursor: 3,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 3,
              entryId: "entry-note",
              revision: 3,
              blobId: "blob-remote",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-note",
                revision: 3,
                blobId: "blob-remote",
                path: "Folder/note.md",
                hash: remoteHash,
              }),
            }),
          ],
        },
      ],
    });
    const client = createPullClient({
      blobs: {
        "blob-remote": await encryptTestBlob(
          "blob-remote",
          new TextEncoder().encode(remoteBody),
        ),
      },
    });

    const service = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      vaultAdapter: adapter,
      pullClient: client,
      onProgress: ignoreProgress,
      onConflict(event) {
        conflicts.push({
          entryId: event.entryId,
          reason: event.reason,
          originalPath: event.originalPath,
          conflictPath: event.conflictPath,
        });
      },
      now: conflictTimestamp,
    });

    await expect(service.pullOnce(session)).resolves.toEqual({
      cursor: 3,
      entriesApplied: 1,
      filesWritten: 1,
      filesDeleted: 0,
      conflictsCreated: 1,
    });
    expect(adapter.text("Folder/note.md")).toBe(remoteBody);
    expect(adapter.text("Folder/note.sync-conflict-20260422-101112.md")).toBe(
      localBody,
    );
    expect(await store.getRemoteStateById("entry-note")).toMatchObject({
      revision: 3,
      blobId: "blob-remote",
      hash: remoteHash,
    });
    expect(await store.listDirtyEntries()).toEqual([]);
    expect(conflicts).toEqual([
      {
        entryId: "entry-note",
        reason: "local_pending_mutation",
        originalPath: "Folder/note.md",
        conflictPath: "Folder/note.sync-conflict-20260422-101112.md",
      },
    ]);

    await store.close();
  });

  it("creates a conflict copy for non-mergeable binary paths even with a cached base blob", async () => {
    const store = createTestSyncStore();
    const path = "Folder/image.png";
    const conflictPath = "Folder/image.sync-conflict-20260422-101112.png";
    const baseBytes = new Uint8Array([0, 1, 2, 3]);
    const localBytes = new Uint8Array([0, 1, 9, 3]);
    const remoteBytes = new Uint8Array([0, 8, 2, 3]);
    const baseHash = await hashBytes(baseBytes);
    const localHash = await hashBytes(localBytes);
    const remoteHash = await hashBytes(remoteBytes);
    const adapter = createVaultAdapter({
      [path]: localBytes,
    });
    await arrangePendingUpsertWithCachedBase(store, {
      entryId: "entry-image",
      path,
      baseRevision: 2,
      baseBlobId: "blob-base",
      baseHash,
      baseBytes,
      localBlobId: "blob-local",
      localHash,
      createdAt: 3,
    });

    const conflicts: PullConflictSummary[] = [];
    const session = createRealtimeSession({
      pages: [
        {
          cursor: 3,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 3,
              entryId: "entry-image",
              revision: 3,
              blobId: "blob-remote",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-image",
                revision: 3,
                blobId: "blob-remote",
                path,
                hash: remoteHash,
              }),
            }),
          ],
        },
      ],
    });
    const client = createPullClient({
      blobs: {
        "blob-remote": await encryptTestBlob("blob-remote", remoteBytes),
      },
    });

    const service = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      vaultAdapter: adapter,
      pullClient: client,
      onProgress: ignoreProgress,
      onConflict(event) {
        conflicts.push({
          entryId: event.entryId,
          reason: event.reason,
          originalPath: event.originalPath,
          conflictPath: event.conflictPath,
        });
      },
      now: conflictTimestamp,
    });

    await expect(service.pullOnce(session)).resolves.toEqual({
      cursor: 3,
      entriesApplied: 1,
      filesWritten: 1,
      filesDeleted: 0,
      conflictsCreated: 1,
    });
    expect(adapter.bytes(path)).toEqual(remoteBytes);
    expect(adapter.bytes(conflictPath)).toEqual(localBytes);
    expect(await store.getRemoteStateById("entry-image")).toMatchObject({
      revision: 3,
      blobId: "blob-remote",
      hash: remoteHash,
    });
    expect(await store.listDirtyEntries()).toEqual([]);
    expect(conflicts).toEqual([
      {
        entryId: "entry-image",
        reason: "local_pending_mutation",
        originalPath: path,
        conflictPath,
      },
    ]);

    await store.close();
  });
});
