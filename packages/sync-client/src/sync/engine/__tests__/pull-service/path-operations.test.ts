import { createTestContentRuntime } from "../../../../test-support/content-runtime";
import { describe, expect, it, vi } from "vitest";

import { SyncPullService } from "../../pull-service";
import { listBlockedSyncFiles, listFileSizeBlockedFiles } from "../../file-size-blocked";
import { isPortableVaultPath } from "../../../core/portable-path";
import { createTestSyncStore } from "../../../../test-support/in-memory-sync-store";
import {
  createCommit,
  createEventGate,
  createBlobClient,
  createRealtimeSession,
  createToken,
  createVaultAdapter,
  encryptRemoteMetadata,
  encryptTestBlob,
  hashText,
  ignoreProgress,
  type PullConflictSummary,
  TEST_VAULT_KEY,
} from "./helpers";

describe("SyncPullService path operations", () => {
  it.each([false, true])(
    "preserves a blocked rename's local path (paginated: %s)",
    async (paginated) => {
      const store = createTestSyncStore();
      const adapter = createVaultAdapter({ "a.md": "content A", "b.md": "content B" });
      for (const id of ["a", "b"]) {
        await store.upsertEntry({
          entryId: id,
          path: `${id}.md`,
          revision: 1,
          blobId: `blob-${id}`,
          hash: await hashText(`content ${id.toUpperCase()}`),
          deleted: false,
          updatedAt: 1,
        });
      }
      const commits = [];
      for (const [id, path, cursor] of [
        ["a", "bad:name.md", 2],
        ["b", "a.md", 3],
      ] as const) {
        commits.push(createCommit({
          cursor,
          entryId: id,
          revision: 2,
          baseRevision: 1,
          blobId: `blob-${id}`,
          encryptedMetadata: await encryptRemoteMetadata({
            entryId: id,
            revision: 2,
            blobId: `blob-${id}`,
            path,
            hash: await hashText(`content ${id.toUpperCase()}`),
          }),
        }));
      }
      const conflicts: PullConflictSummary[] = [];
      const blobClient = createBlobClient({
        blobs: {
          "blob-b": await encryptTestBlob("blob-b", new TextEncoder().encode("content B")),
        },
      });
      const download = vi.spyOn(blobClient, "downloadBlob");
      const service = new SyncPullService({
        contentRuntime: createTestContentRuntime(),
        getSyncToken: async () => createToken(),
        getSyncStore: () => store,
        getRemoteVaultKey: () => TEST_VAULT_KEY,
        shouldApplyRemotePath: (path, deleted) => deleted || isPortableVaultPath(path),
        vaultAdapter: adapter,
        blobClient,
        applyWindowSize: paginated ? 1 : undefined,
        onConflict: (event) => conflicts.push(event),
        onProgress: ignoreProgress,
      });
      const pages = paginated
        ? commits.map((commit, index) => ({
            cursor: commit.cursor,
            hasMore: index === 0,
            commits: [commit],
          }))
        : [{ cursor: 3, hasMore: false, commits }];
      await service.pullOnce(createRealtimeSession({ pages }));

      // The ignored rename and the accepted write share a local path owner;
      // applying the ignored state must not make the write download again.
      expect(download).toHaveBeenCalledTimes(1);
      expect(adapter.text("a.md")).toBe("content A");
      expect(adapter.files.has("bad:name.md")).toBe(false);
      expect(conflicts).toHaveLength(1);
      expect(adapter.text(conflicts[0]!.conflictPath!)).toBe("content B");
      expect(await store.getLocalStateById("a")).toMatchObject({ path: "a.md" });
      expect(await store.getRemoteStateById("a")).toMatchObject({
        path: "bad:name.md", revision: 2,
      });
      expect(await store.getCursor()).toBe(3);
      await store.close();
    },
  );

  it.each(["rename", "delete"] as const)(
    "reports a skipped remote file and clears its warning after a remote %s",
    async (operation) => {
      const store = createTestSyncStore();
      const adapter = createVaultAdapter({});
      const path = "bad:name.md";
      const hash = await hashText("remote content");
      const onRemoteStatesChange = vi.fn();
      const service = new SyncPullService({
        contentRuntime: createTestContentRuntime(),
        getSyncToken: async () => createToken(),
        getSyncStore: () => store,
        getRemoteVaultKey: () => TEST_VAULT_KEY,
        shouldApplyRemotePath: (path, deleted) => deleted || isPortableVaultPath(path),
        vaultAdapter: adapter,
        blobClient: createBlobClient({
          blobs: {
            "blob-remote": await encryptTestBlob(
              "blob-remote", new TextEncoder().encode("remote content"),
            ),
          },
        }),
        onRemoteStatesChange,
        onProgress: ignoreProgress,
      });
      await service.pullOnce(createRealtimeSession({ pages: [{
        cursor: 1,
        hasMore: false,
        commits: [createCommit({
          entryId: "remote",
          blobId: "blob-remote",
          encryptedMetadata: await encryptRemoteMetadata({
            entryId: "remote", revision: 1, blobId: "blob-remote", path, hash,
          }),
        })],
      }] }));

      expect(adapter.files.size).toBe(0);
      expect(await store.listDirtyEntries()).toEqual([]);
      await expect(listBlockedSyncFiles(store, TEST_VAULT_KEY)).resolves.toEqual([{
        path,
        reason: "incompatible_path",
        encryptedSizeBytes: null,
        maxFileSizeBytes: null,
      }]);
      await expect(listFileSizeBlockedFiles(store, TEST_VAULT_KEY)).resolves.toEqual([]);
      expect(onRemoteStatesChange).toHaveBeenCalledTimes(1);

      const deleted = operation === "delete";
      await service.pullOnce(createRealtimeSession({ pages: [{
        cursor: 2,
        hasMore: false,
        commits: [createCommit({
          cursor: 2,
          entryId: "remote",
          revision: 2,
          baseRevision: 1,
          op: deleted ? "delete" : "upsert",
          blobId: deleted ? null : "blob-remote",
          encryptedMetadata: await encryptRemoteMetadata({
            entryId: "remote",
            revision: 2,
            deleted,
            blobId: deleted ? null : "blob-remote",
            path: deleted ? path : "safe.md",
            hash,
          }),
        })],
      }] }));
      await expect(listBlockedSyncFiles(store, TEST_VAULT_KEY)).resolves.toEqual([]);
      expect(onRemoteStatesChange).toHaveBeenCalledTimes(2);
      if (!deleted) expect(adapter.text("safe.md")).toBe("remote content");

      await service.pullOnce(createRealtimeSession({
        pages: [{ cursor: 2, hasMore: false, commits: [] }],
      }));
      expect(onRemoteStatesChange).toHaveBeenCalledTimes(2);
      await store.close();
    },
  );

  it("skips remote vault config writes when the current rules reject the path", async () => {
    const store = createTestSyncStore();
    const adapter = createVaultAdapter({
      ".obsidian/app.json": "{\"theme\":\"local\"}",
    });
    const configHash = await hashText("{\"theme\":\"remote\"}");

    const session = createRealtimeSession({
      pages: [
        {
          cursor: 2,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 2,
              entryId: "entry-config",
              revision: 1,
              blobId: "blob-config",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-config",
                revision: 1,
                blobId: "blob-config",
                path: ".obsidian/app.json",
                hash: configHash,
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
      shouldApplyRemotePath: (path) => path !== ".obsidian/app.json",
      vaultAdapter: adapter,
      blobClient: createBlobClient({}),
      onProgress: ignoreProgress,
    });

    await expect(service.pullOnce(session)).resolves.toEqual({
      cursor: 2,
      entriesApplied: 0,
      filesWritten: 0,
      filesDeleted: 0,
      conflictsCreated: 0,
    });
    expect(adapter.text(".obsidian/app.json")).toBe("{\"theme\":\"local\"}");
    expect(adapter.writes).toEqual([]);
    expect(await store.getRemoteStateById("entry-config")).toMatchObject({
      entryId: "entry-config",
      path: ".obsidian/app.json",
      revision: 1,
      blobId: "blob-config",
      hash: configHash,
      deleted: false,
    });
    expect(await store.getLocalStateById("entry-config")).toBeNull();
    await store.close();
  });

  it("skips multiple config entries sharing a path without exhausting retries", async () => {
    const store = createTestSyncStore();
    const path = ".obsidian/app.json";
    const adapter = createVaultAdapter({ [path]: "local config" });
    const hash = await hashText("remote config");
    const commits = await Promise.all(Array.from({ length: 4 }, async (_, index) => {
      const entryId = `config-${index}`;
      const blobId = `blob-${index}`;
      return createCommit({
        cursor: index + 1, entryId, revision: 1, blobId,
        encryptedMetadata: await encryptRemoteMetadata({
          entryId, revision: 1, blobId, path, hash,
        }),
      });
    }));
    const service = new SyncPullService({
      contentRuntime: createTestContentRuntime(),
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      shouldApplyRemotePath: () => false,
      vaultAdapter: adapter,
      blobClient: createBlobClient({}),
    });

    await expect(service.pullOnce(createRealtimeSession({
      pages: [{ cursor: 4, hasMore: false, commits }],
    }))).resolves.toEqual({
      cursor: 4, entriesApplied: 0, filesWritten: 0, filesDeleted: 0, conflictsCreated: 0,
    });
    expect(await store.getCursor()).toBe(4);
    expect(await store.listRemoteStates()).toHaveLength(4);
    expect(await store.listLocalStates()).toEqual([]);
    expect(adapter.text(path)).toBe("local config");
    expect(adapter.writes).toEqual([]);
    await store.close();
  });

  it.each([false, true])(
    "preserves a directory at a tombstone's historical path (already known: %s)",
    async (alreadyKnown) => {
      const store = createTestSyncStore();
      const adapter = createVaultAdapter({ "folder/note.md": "local note" });
      await adapter.mkdir("folder");
      if (alreadyKnown) {
        await store.upsertEntry({
          entryId: "old-file", path: "folder", revision: 2, blobId: null,
          hash: null, deleted: true, updatedAt: 1,
        });
      }
      const commit = createCommit({
        cursor: 2, entryId: "old-file", revision: 2, op: "delete", blobId: null,
        encryptedMetadata: await encryptRemoteMetadata({
          entryId: "old-file", revision: 2, deleted: true, blobId: null, path: "folder",
        }),
      });
      const service = new SyncPullService({
        contentRuntime: createTestContentRuntime(),
        getSyncToken: async () => createToken(),
        getSyncStore: () => store,
        getRemoteVaultKey: () => TEST_VAULT_KEY,
        vaultAdapter: adapter,
        blobClient: createBlobClient({}),
      });

      await expect(service.pullOnce(createRealtimeSession({
        pages: [{ cursor: 2, hasMore: false, commits: [commit] }],
      }))).resolves.toMatchObject({ cursor: 2, filesWritten: 0, filesDeleted: 0 });
      expect(await store.getCursor()).toBe(2);
      expect(await store.getRemoteStateById("old-file")).toMatchObject({
        revision: 2, deleted: true,
      });
      expect(await adapter.exists("folder")).toBe(true);
      expect(adapter.text("folder/note.md")).toBe("local note");
      expect(adapter.removes).toEqual([]);
      await store.close();
    },
  );

  it("applies a tombstone when live writes for the path are rejected", async () => {
    const store = createTestSyncStore();
    const path = "Notes/a:b.md";
    const adapter = createVaultAdapter({ [path]: "legacy content" });
    await store.upsertEntry({
      entryId: "entry-incompatible",
      path,
      revision: 1,
      blobId: "blob-legacy",
      hash: await hashText("legacy content"),
      deleted: false,
      updatedAt: 1,
    });

    const session = createRealtimeSession({
      pages: [
        {
          cursor: 2,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 2,
              entryId: "entry-incompatible",
              op: "delete",
              revision: 2,
              baseRevision: 1,
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-incompatible",
                revision: 2,
                deleted: true,
                blobId: null,
                path,
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
      shouldApplyRemotePath: (_path, deleted) => deleted,
      vaultAdapter: adapter,
      blobClient: createBlobClient({}),
      onProgress: ignoreProgress,
    });

    await expect(service.pullOnce(session)).resolves.toMatchObject({
      cursor: 2,
      entriesApplied: 1,
      filesDeleted: 1,
    });
    expect(adapter.files.has(path)).toBe(false);
    expect(await store.getRemoteStateById("entry-incompatible")).toMatchObject({
      revision: 2,
      deleted: true,
    });
    await store.close();
  });

  it("applies remote path changes using a vault rename", async () => {
    const store = createTestSyncStore();
    const adapter = createVaultAdapter({
      "Old/path.md": "old content",
    });
    const suppressionCalls: string[][] = [];
    await store.upsertEntry({
      entryId: "entry-rename",
      path: "Old/path.md",
      revision: 1,
      blobId: "blob-old",
      hash: await hashText("old content"),
      deleted: false,
      updatedAt: 1,
    });

    const session = createRealtimeSession({
      pages: [
        {
          cursor: 2,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 2,
              entryId: "entry-rename",
              revision: 2,
              blobId: "blob-new",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-rename",
                revision: 2,
                blobId: "blob-new",
                path: "New/path.md",
                hash: await hashText("renamed content"),
              }),
            }),
          ],
        },
      ],
    });
    const client = createBlobClient({
      blobs: {
        "blob-new": await encryptTestBlob(
          "blob-new",
          new TextEncoder().encode("renamed content"),
        ),
      },
    });

    const service = new SyncPullService({
      contentRuntime: createTestContentRuntime(),
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      vaultAdapter: adapter,
      eventGate: createEventGate(suppressionCalls),
      blobClient: client,
      onProgress: ignoreProgress,
    });

    const result = await service.pullOnce(session);

    expect(result).toEqual({
      cursor: 2,
      entriesApplied: 1,
      filesWritten: 1,
      filesDeleted: 0,
      conflictsCreated: 0,
    });
    expect(adapter.renames).toEqual([
      { oldPath: "Old/path.md", newPath: "New/path.md" },
    ]);
    expect(adapter.removes).toEqual([]);
    expect(adapter.text("Old/path.md")).toBeNull();
    expect(adapter.text("New/path.md")).toBe("renamed content");
    expect(await store.getEntryById("entry-rename")).toEqual({
      entryId: "entry-rename",
      path: "New/path.md",
      revision: 2,
      blobId: "blob-new",
      hash: await hashText("renamed content"),
      deleted: false,
      updatedAt: 2,
      localMtime: null,
      localSize: null,
    });
    expect(suppressionCalls).toEqual([["Old/path.md", "New/path.md"]]);
    await store.close();
  });

  it("handles renames and deletes using the stored entry mapping", async () => {
    const store = createTestSyncStore();
    const adapter = createVaultAdapter({
      "Old/path.md": "old content",
    });
    const suppressionCalls: string[][] = [];
    await store.upsertEntry({
      entryId: "entry-1",
      path: "Old/path.md",
      revision: 1,
      blobId: "blob-old",
      hash: await hashText("old content"),
      deleted: false,
      updatedAt: 1,
    });

    const session = createRealtimeSession({
      pages: [
        {
          cursor: 3,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 2,
              entryId: "entry-1",
              revision: 2,
              blobId: "blob-rename",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-1",
                revision: 2,
                blobId: "blob-rename",
                path: "New/path.md",
                hash: await hashText("renamed content"),
              }),
            }),
            createCommit({
              cursor: 3,
              entryId: "entry-1",
              op: "delete",
              revision: 3,
              baseRevision: 2,
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-1",
                revision: 3,
                deleted: true,
                blobId: null,
                path: "New/path.md",
              }),
            }),
          ],
        },
      ],
    });
    const client = createBlobClient({
      blobs: {
        "blob-rename": await encryptTestBlob(
          "blob-rename",
          new TextEncoder().encode("renamed content"),
        ),
      },
    });

    const service = new SyncPullService({
      contentRuntime: createTestContentRuntime(),
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      vaultAdapter: adapter,
      eventGate: createEventGate(suppressionCalls),
      blobClient: client,
      onProgress: ignoreProgress,
    });

    const result = await service.pullOnce(session);

    expect(result).toEqual({
      cursor: 3,
      entriesApplied: 1,
      filesWritten: 0,
      filesDeleted: 1,
      conflictsCreated: 0,
    });
    expect(adapter.files.size).toBe(0);
    expect(await store.getCursor()).toBe(3);
    expect(await store.getEntryById("entry-1")).toEqual({
      entryId: "entry-1",
      path: "New/path.md",
      revision: 3,
      blobId: null,
      hash: null,
      deleted: true,
      updatedAt: 3,
      localMtime: null,
      localSize: null,
    });
    expect(suppressionCalls).toEqual([["Old/path.md"]]);
    await store.close();
  });

  it("applies path swaps as one dependency batch", async () => {
    const store = createTestSyncStore();
    const adapter = createVaultAdapter({
      "Folder/a.md": "old a",
      "Folder/b.md": "old b",
    });
    const suppressionCalls: string[][] = [];
    await store.upsertEntry({
      entryId: "entry-a",
      path: "Folder/a.md",
      revision: 1,
      blobId: "blob-a-old",
      hash: "hash-a",
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: null,
    });
    await store.upsertEntry({
      entryId: "entry-b",
      path: "Folder/b.md",
      revision: 1,
      blobId: "blob-b-old",
      hash: "hash-b",
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: null,
    });

    const session = createRealtimeSession({
      pages: [
        {
          cursor: 3,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 2,
              entryId: "entry-a",
              revision: 2,
              blobId: "blob-a-new",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-a",
                revision: 2,
                blobId: "blob-a-new",
                path: "Folder/b.md",
                hash: await hashText("new a"),
              }),
            }),
            createCommit({
              cursor: 3,
              entryId: "entry-b",
              revision: 2,
              blobId: "blob-b-new",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-b",
                revision: 2,
                blobId: "blob-b-new",
                path: "Folder/a.md",
                hash: await hashText("new b"),
              }),
            }),
          ],
        },
      ],
    });
    const client = createBlobClient({
      blobs: {
        "blob-a-new": await encryptTestBlob("blob-a-new", new TextEncoder().encode("new a")),
        "blob-b-new": await encryptTestBlob("blob-b-new", new TextEncoder().encode("new b")),
      },
    });

    const service = new SyncPullService({
      contentRuntime: createTestContentRuntime(),
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      vaultAdapter: adapter,
      eventGate: createEventGate(suppressionCalls),
      blobClient: client,
      onProgress: ignoreProgress,
    });

    await expect(service.pullOnce(session)).resolves.toEqual({
      cursor: 3,
      entriesApplied: 2,
      filesWritten: 2,
      filesDeleted: 2,
      conflictsCreated: 0,
    });
    expect(adapter.text("Folder/a.md")).toBe("new b");
    expect(adapter.text("Folder/b.md")).toBe("new a");
    expect((await store.getEntryById("entry-a"))?.path).toBe("Folder/b.md");
    expect((await store.getEntryById("entry-b"))?.path).toBe("Folder/a.md");
    expect(suppressionCalls).toEqual([["Folder/a.md", "Folder/b.md"]]);

    await store.close();
  });

  it("applies path swaps split across pull pages as one manifest", async () => {
    const store = createTestSyncStore();
    const adapter = createVaultAdapter({
      "Folder/a.md": "old a",
      "Folder/b.md": "old b",
    });
    await store.upsertEntry({
      entryId: "entry-a",
      path: "Folder/a.md",
      revision: 1,
      blobId: "blob-a-old",
      hash: "hash-a",
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: null,
    });
    await store.upsertEntry({
      entryId: "entry-b",
      path: "Folder/b.md",
      revision: 1,
      blobId: "blob-b-old",
      hash: "hash-b",
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: null,
    });

    const fillerCommits = await Promise.all(
      Array.from({ length: 49 }, async (_, index) => {
        const id = index + 1;
        const body = `filler ${id}`;
        return createCommit({
          cursor: id + 1,
          entryId: `entry-filler-${id}`,
          revision: 1,
          blobId: `blob-filler-${id}`,
          encryptedMetadata: await encryptRemoteMetadata({
            entryId: `entry-filler-${id}`,
            revision: 1,
            blobId: `blob-filler-${id}`,
            path: `Folder/filler-${id}.md`,
            hash: await hashText(body),
          }),
        });
      }),
    );
    const session = createRealtimeSession({
      pages: [
        {
          cursor: 50,
          hasMore: true,
          commits: [
            createCommit({
              cursor: 1,
              entryId: "entry-a",
              revision: 2,
              blobId: "blob-a-new",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-a",
                revision: 2,
                blobId: "blob-a-new",
                path: "Folder/b.md",
                hash: await hashText("new a"),
              }),
            }),
            ...fillerCommits,
          ],
        },
        {
          cursor: 51,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 51,
              entryId: "entry-b",
              revision: 2,
              blobId: "blob-b-new",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-b",
                revision: 2,
                blobId: "blob-b-new",
                path: "Folder/a.md",
                hash: await hashText("new b"),
              }),
            }),
          ],
        },
      ],
    });
    const client = createBlobClient({
      blobs: {
        "blob-a-new": await encryptTestBlob("blob-a-new", new TextEncoder().encode("new a")),
        "blob-b-new": await encryptTestBlob("blob-b-new", new TextEncoder().encode("new b")),
        ...Object.fromEntries(
          await Promise.all(
            Array.from({ length: 49 }, async (_, index) => {
              const id = index + 1;
              return [
                `blob-filler-${id}`,
                await encryptTestBlob(
                  `blob-filler-${id}`,
                  new TextEncoder().encode(`filler ${id}`),
                ),
              ] as const;
            }),
          ),
        ),
      },
    });
    const conflicts: PullConflictSummary[] = [];

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
    });

    await expect(service.pullOnce(session)).resolves.toMatchObject({
      cursor: 51,
      entriesApplied: 51,
      filesWritten: 51,
      filesDeleted: 2,
      conflictsCreated: 0,
    });
    expect(adapter.text("Folder/a.md")).toBe("new b");
    expect(adapter.text("Folder/b.md")).toBe("new a");
    expect(conflicts).toEqual([]);

    await store.close();
  });

});
