import { describe, expect, it } from "vitest";

import { SyncPullService } from "../../pull-service";
import { createInitializedTestSyncStore, createTestPlugin } from "../../../../test-support/test-plugin";
import {
  createCommit,
  createEventGate,
  createPullClient,
  createRealtimeSession,
  createToken,
  createVaultAdapter,
  encryptRemoteMetadata,
  encryptTestBlob,
  hashText,
  ignoreProgress,
  TEST_VAULT_KEY,
} from "./helpers";

describe("SyncPullService path operations", () => {
  it("skips remote vault config writes when the current rules reject the path", async () => {
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
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
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      shouldApplyRemotePath: (path) => path !== ".obsidian/app.json",
      vaultAdapter: adapter,
      pullClient: createPullClient({}),
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

  it("applies remote path changes using a vault rename", async () => {
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
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
    const client = createPullClient({
      blobs: {
        "blob-new": await encryptTestBlob(
          "blob-new",
          new TextEncoder().encode("renamed content"),
        ),
      },
    });

    const service = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      vaultAdapter: adapter,
      eventGate: createEventGate(suppressionCalls),
      pullClient: client,
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
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
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
    const client = createPullClient({
      blobs: {
        "blob-rename": await encryptTestBlob(
          "blob-rename",
          new TextEncoder().encode("renamed content"),
        ),
      },
    });

    const service = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      vaultAdapter: adapter,
      eventGate: createEventGate(suppressionCalls),
      pullClient: client,
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
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
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
    const client = createPullClient({
      blobs: {
        "blob-a-new": await encryptTestBlob("blob-a-new", new TextEncoder().encode("new a")),
        "blob-b-new": await encryptTestBlob("blob-b-new", new TextEncoder().encode("new b")),
      },
    });

    const service = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      vaultAdapter: adapter,
      eventGate: createEventGate(suppressionCalls),
      pullClient: client,
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
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
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
    const client = createPullClient({
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
