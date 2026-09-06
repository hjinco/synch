import { createTestContentRuntime } from "../../../../test-support/content-runtime";
import { describe, expect, it } from "vitest";

import { SyncPullService } from "../../pull-service";
import { createTestSyncStore } from "../../../../test-support/in-memory-sync-store";
import {
  createCommit,
  createBlobClient,
  createRealtimeSession,
  createToken,
  createVaultAdapter,
  encryptPendingMetadata,
  encryptRemoteMetadata,
  encryptTestBlob,
  hashText,
  ignoreProgress,
  TEST_VAULT_KEY,
  type PullConflictSummary,
} from "./helpers";

const conflictTimestamp = () => new Date(2026, 3, 22, 10, 11, 12).getTime();

describe("SyncPullService pending upsert conflict resolution", () => {
  it("lets the latest remote vault config replace a pending local version without a conflict copy", async () => {
    const store = createTestSyncStore();
    const path = ".obsidian/graph.json";
    const adapter = {
      ...createVaultAdapter({
        [path]: '{"local":true}',
      }),
      isProtectedVaultPath: (candidate: string) =>
        candidate.includes(".sync-conflict-"),
    };
    const localHash = await hashText('{"local":true}');
    const remoteHash = await hashText('{"remote":true}');
    await store.upsertEntry({
      entryId: "entry-graph",
      path,
      revision: 2,
      blobId: "blob-current",
      hash: localHash,
      deleted: false,
      updatedAt: 1,
    });
    await store.markEntryDirty({
      mutationId: "mutation-graph",
      entryId: "entry-graph",
      op: "upsert",
      baseRevision: 2,
      blobId: "blob-local",
      hash: localHash,
      encryptedMetadata: await encryptPendingMetadata({
        entryId: "entry-graph",
        baseRevision: 2,
        op: "upsert",
        blobId: "blob-local",
        path,
        hash: localHash,
      }),
      createdAt: 2,
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
              entryId: "entry-graph",
              revision: 3,
              blobId: "blob-remote",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-graph",
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
    const service = new SyncPullService({
      contentRuntime: createTestContentRuntime(),
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      shouldUseLatestRemoteVersion: (candidate) => candidate.startsWith(".obsidian/"),
      vaultAdapter: adapter,
      blobClient: createBlobClient({
        blobs: {
          "blob-remote": await encryptTestBlob(
            "blob-remote",
            new TextEncoder().encode('{"remote":true}'),
          ),
        },
      }),
      onProgress: ignoreProgress,
      onConflict: (event) => conflicts.push(event),
      now: conflictTimestamp,
    });

    await expect(service.pullOnce(session)).resolves.toEqual({
      cursor: 3,
      entriesApplied: 1,
      filesWritten: 1,
      filesDeleted: 0,
      conflictsCreated: 0,
    });
    expect(adapter.text(path)).toBe('{"remote":true}');
    expect(adapter.text(".obsidian/graph.sync-conflict-20260422-101112.json")).toBeNull();
    expect(await store.listDirtyEntries()).toEqual([]);
    expect(conflicts).toEqual([]);

    await store.close();
  });

  it("clears a same-entry pending upsert when the pulled remote state has identical content", async () => {
    const store = createTestSyncStore();
    const body = "same body";
    const hash = await hashText(body);
    const adapter = createVaultAdapter({
      "Folder/note.md": body,
    });
    await store.upsertEntry({
      entryId: "entry-note",
      path: "Folder/note.md",
      revision: 2,
      blobId: "blob-current",
      hash,
      deleted: false,
      updatedAt: 1,
    });
    await store.markEntryDirty({
      mutationId: "mutation-note",
      entryId: "entry-note",
      op: "upsert",
      baseRevision: 2,
      blobId: "blob-local-pending",
      hash,
      encryptedMetadata: await encryptPendingMetadata({
        entryId: "entry-note",
        baseRevision: 2,
        op: "upsert",
        blobId: "blob-local-pending",
        path: "Folder/note.md",
        hash,
      }),
      createdAt: 2,
    });

    const conflicts: Array<{ originalPath: string; conflictPath: string | null }> = [];
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
                hash,
              }),
            }),
          ],
        },
      ],
    });
    const client = createBlobClient({
      blobs: {
        "blob-remote": await encryptTestBlob(
          "blob-remote",
          new TextEncoder().encode(body),
        ),
      },
    });

    const service = new SyncPullService({
      contentRuntime: createTestContentRuntime(),
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      vaultAdapter: adapter,
      blobClient: client,
      onProgress: ignoreProgress,
      onConflict(event) {
        conflicts.push({
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
    expect(adapter.text("Folder/note.md")).toBe(body);
    expect(adapter.text("Folder/note.sync-conflict-20260422-101112.md")).toBeNull();
    expect(conflicts).toEqual([]);
    expect(await store.listDirtyEntries()).toEqual([]);
    expect(await store.getEntryById("entry-note")).toMatchObject({
      revision: 3,
      blobId: "blob-remote",
      hash,
    });

    await store.close();
  });

  it("preserves current vault content when a matching pending upsert is stale", async () => {
    const store = createTestSyncStore();
    const queuedBody = "same body";
    const currentBody = "changed after queue";
    const hash = await hashText(queuedBody);
    const adapter = createVaultAdapter({
      "Folder/note.md": currentBody,
    });
    await store.upsertEntry({
      entryId: "entry-note",
      path: "Folder/note.md",
      revision: 2,
      blobId: "blob-current",
      hash,
      deleted: false,
      updatedAt: 1,
    });
    await store.markEntryDirty({
      mutationId: "mutation-note",
      entryId: "entry-note",
      op: "upsert",
      baseRevision: 2,
      blobId: "blob-local-pending",
      hash,
      encryptedMetadata: await encryptPendingMetadata({
        entryId: "entry-note",
        baseRevision: 2,
        op: "upsert",
        blobId: "blob-local-pending",
        path: "Folder/note.md",
        hash,
      }),
      createdAt: 2,
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
                hash,
              }),
            }),
          ],
        },
      ],
    });
    const client = createBlobClient({
      blobs: {
        "blob-remote": await encryptTestBlob(
          "blob-remote",
          new TextEncoder().encode(queuedBody),
        ),
      },
    });

    const service = new SyncPullService({
      contentRuntime: createTestContentRuntime(),
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      vaultAdapter: adapter,
      blobClient: client,
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
    expect(adapter.text("Folder/note.md")).toBe(queuedBody);
    expect(adapter.text("Folder/note.sync-conflict-20260422-101112.md")).toBe(
      currentBody,
    );
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

  it("preserves pending local upserts before applying conflicting remote changes", async () => {
    const store = createTestSyncStore();
    const adapter = createVaultAdapter({
      "Folder/note.md": "local body",
    });
    await store.upsertEntry({
      entryId: "entry-note",
      path: "Folder/note.md",
      revision: 2,
      blobId: "blob-current",
      hash: "local-hash",
      deleted: false,
      updatedAt: 1,
    });
    await store.markEntryDirty({
      mutationId: "mutation-note",
      entryId: "entry-note",
      op: "upsert",
      baseRevision: 2,
      blobId: "blob-local-pending",
      hash: "local-hash",
      encryptedMetadata: await encryptPendingMetadata({
        entryId: "entry-note",
        baseRevision: 2,
        op: "upsert",
        blobId: "blob-local-pending",
        path: "Folder/note.md",
        hash: "local-hash",
      }),
      createdAt: 2,
    });

    const conflicts: Array<{ originalPath: string; conflictPath: string | null }> = [];
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
                hash: await hashText("remote body"),
              }),
            }),
          ],
        },
      ],
    });
    const client = createBlobClient({
      blobs: {
        "blob-remote": await encryptTestBlob(
          "blob-remote",
          new TextEncoder().encode("remote body"),
        ),
      },
    });

    const service = new SyncPullService({
      contentRuntime: createTestContentRuntime(),
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      vaultAdapter: adapter,
      blobClient: client,
      onProgress: ignoreProgress,
      onConflict(event) {
        conflicts.push({
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
    expect(adapter.text("Folder/note.md")).toBe("remote body");
    expect(adapter.text("Folder/note.sync-conflict-20260422-101112.md")).toBe("local body");
    expect(conflicts).toEqual([
      {
        originalPath: "Folder/note.md",
        conflictPath: "Folder/note.sync-conflict-20260422-101112.md",
      },
    ]);
    expect(await store.listDirtyEntries()).toEqual([]);
    expect((await store.getEntryById("entry-note"))?.revision).toBe(3);

    await store.close();
  });
});
