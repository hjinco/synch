import { describe, expect, it } from "vitest";

import { hashBytes } from "../../../core/content";
import { SyncPullService } from "../../pull-service";
import { createTestSyncStore } from "../../../../test-support/in-memory-sync-store";
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

describe("SyncPullService paging", () => {
  it("pulls paged changes, writes files, and updates the cursor", async () => {
    const store = createTestSyncStore();
    const adapter = createVaultAdapter();
    const suppressionCalls: string[][] = [];
    const progressUpdates: Array<{ completedEntries: number; totalEntries: number }> = [];
    const fileSyncEvents: string[] = [];
    const session = createRealtimeSession({
      pages: [
        {
          cursor: 1,
          hasMore: true,
          commits: [
            createCommit({
              cursor: 1,
              entryId: "entry-1",
              revision: 1,
              blobId: "blob-1",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-1",
                revision: 1,
                blobId: "blob-1",
                path: "Folder/note-a.md",
                hash: await hashText("hello world"),
              }),
            }),
          ],
        },
        {
          cursor: 2,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 2,
              entryId: "entry-2",
              revision: 1,
              blobId: "blob-2",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-2",
                revision: 1,
                blobId: "blob-2",
                path: "Folder/note-b.md",
                hash: await hashText("blob content"),
              }),
            }),
          ],
        },
      ],
    });
    const client = createPullClient({
      blobs: {
        "blob-1": await encryptTestBlob("blob-1", new TextEncoder().encode("hello world")),
        "blob-2": await encryptTestBlob("blob-2", new TextEncoder().encode("blob content")),
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

    const result = await service.pullOnce(session);

    expect(result).toEqual({
      cursor: 2,
      entriesApplied: 2,
      filesWritten: 2,
      filesDeleted: 0,
      conflictsCreated: 0,
    });
    expect(adapter.text("Folder/note-a.md")).toBe("hello world");
    expect(adapter.text("Folder/note-b.md")).toBe("blob content");
    expect(await store.getCursor()).toBe(2);
    expect((await store.getEntryById("entry-1"))?.path).toBe("Folder/note-a.md");
    expect((await store.getEntryById("entry-2"))?.blobId).toBe("blob-2");
    expect(progressUpdates).toEqual([{ completedEntries: 2, totalEntries: 2 }]);
    expect(fileSyncEvents).toEqual([
      "started:upsert:Folder/note-a.md",
      "started:upsert:Folder/note-b.md",
      "completed:upsert:Folder/note-a.md:1",
      "completed:upsert:Folder/note-b.md:1",
    ]);
    expect(suppressionCalls).toEqual([["Folder/note-a.md", "Folder/note-b.md"]]);
    await store.close();
  });

  it("skips downloading and writing blobs already applied from an accepted push", async () => {
    const store = createTestSyncStore();
    const body = "already uploaded locally";
    const path = "Folder/already-current.md";
    const blobId = "blob-already-current";
    const hash = await hashText(body);
    await store.setCursor(7);
    await store.upsertEntry({
      entryId: "entry-current",
      path,
      revision: 3,
      blobId,
      hash,
      deleted: false,
      updatedAt: 1,
      localMtime: 123,
      localSize: body.length,
    });

    const adapter = createVaultAdapter({ [path]: body });
    const session = createRealtimeSession({
      pages: [
        {
          cursor: 8,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 8,
              entryId: "entry-current",
              revision: 3,
              blobId,
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-current",
                revision: 3,
                blobId,
                path,
                hash,
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
      vaultAdapter: adapter,
      pullClient: createPullClient({}),
      onProgress: ignoreProgress,
    });

    await expect(service.pullOnce(session)).resolves.toEqual({
      cursor: 8,
      entriesApplied: 1,
      filesWritten: 0,
      filesDeleted: 0,
      conflictsCreated: 0,
    });
    expect(adapter.text(path)).toBe(body);
    expect(await store.getCursor()).toBe(8);
    expect(await store.getEntryById("entry-current")).toMatchObject({
      path,
      revision: 3,
      blobId,
      hash,
      localMtime: 123,
      localSize: body.length,
    });
    await store.close();
  });

  it("reports remote pull progress across pages instead of capping totals at apply windows", async () => {
    const store = createTestSyncStore();
    const adapter = createVaultAdapter();
    const commits = await Promise.all(
      Array.from({ length: 5 }, async (_, index) =>
        createCommit({
          cursor: index + 1,
          entryId: `entry-${index}`,
          revision: 1,
          blobId: `blob-${index}`,
          encryptedMetadata: await encryptRemoteMetadata({
            entryId: `entry-${index}`,
            revision: 1,
            blobId: `blob-${index}`,
            path: `Folder/note-${index}.md`,
            hash: await hashText(`body-${index}`),
          }),
        }),
      ),
    );
    const blobs: Record<string, string | Uint8Array> = {};
    for (const [index, commit] of commits.entries()) {
      if (!commit.blobId) {
        throw new Error("test commit should have a blob");
      }
      blobs[commit.blobId] = await encryptTestBlob(
        commit.blobId,
        new TextEncoder().encode(`body-${index}`),
      );
    }
    const progressUpdates: Array<{ completedEntries: number; totalEntries: number }> = [];
    const session = createRealtimeSession({
      pages: [
        { cursor: 5, hasMore: true, commits: commits.slice(0, 2) },
        { cursor: 5, hasMore: true, commits: commits.slice(2, 4) },
        { cursor: 5, hasMore: false, commits: commits.slice(4) },
      ],
    });
    const client = createPullClient({ blobs });

    const service = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      vaultAdapter: adapter,
      pullClient: client,
      applyWindowSize: 2,
      onProgress: async (progress) => {
        progressUpdates.push(progress);
      },
    });

    await expect(service.pullOnce(session)).resolves.toMatchObject({
      cursor: 5,
      entriesApplied: 5,
    });
    expect(progressUpdates).toEqual([
      { completedEntries: 2, totalEntries: 5 },
      { completedEntries: 4, totalEntries: 5 },
      { completedEntries: 5, totalEntries: 5 },
    ]);
    await store.close();
  });

  it("writes binary attachments without decoding them as text first", async () => {
    const store = createTestSyncStore();
    const adapter = createVaultAdapter();
    const binaryBlob = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

    const session = createRealtimeSession({
      pages: [
        {
          cursor: 1,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 1,
              entryId: "entry-image",
              revision: 1,
              blobId: "blob-image",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-image",
                revision: 1,
                blobId: "blob-image",
                path: "Attachments/image.png",
                hash: await hashBytes(binaryBlob),
              }),
            }),
          ],
        },
      ],
    });
    const client = createPullClient({
      blobs: {
        "blob-image": await encryptTestBlob("blob-image", binaryBlob),
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
    });

    const result = await service.pullOnce(session);

    expect(result).toEqual({
      cursor: 1,
      entriesApplied: 1,
      filesWritten: 1,
      filesDeleted: 0,
      conflictsCreated: 0,
    });
    expect(adapter.bytes("Attachments/image.png")).toEqual(binaryBlob);
    expect((await store.getEntryById("entry-image"))?.hash).toBeTruthy();

    await store.close();
  });

  it("prepares independent blobs concurrently with the configured pool before applying them in order", async () => {
    const store = createTestSyncStore();
    const adapter = createVaultAdapter();
    const blobIds = Array.from({ length: 12 }, (_, index) => `blob-${index + 1}`);
    const bodies = Object.fromEntries(
      blobIds.map((blobId, index) => [blobId, `body ${index + 1}`]),
    );
    const encryptedBlobs = Object.fromEntries(
      await Promise.all(
        blobIds.map(async (blobId) => [
          blobId,
          await encryptTestBlob(blobId, new TextEncoder().encode(bodies[blobId])),
        ]),
      ),
    );
    const commits = await Promise.all(
      blobIds.map(async (blobId, index) =>
        createCommit({
          cursor: index + 1,
          entryId: `entry-${index + 1}`,
          revision: 1,
          blobId,
          encryptedMetadata: await encryptRemoteMetadata({
            entryId: `entry-${index + 1}`,
            revision: 1,
            blobId,
            path: `Folder/note-${index + 1}.md`,
            hash: await hashText(bodies[blobId]),
          }),
        }),
      ),
    );
    const session = createRealtimeSession({
      pages: [
        {
          cursor: 6,
          hasMore: false,
          commits,
        },
      ],
    });
    let activeDownloads = 0;
    let maxActiveDownloads = 0;
    const downloadOrder: string[] = [];
    const waitForThirdDownload: Array<() => void> = [];
    const releaseThirdDownload = () => {
      for (const resolve of waitForThirdDownload.splice(0)) {
        resolve();
      }
    };
    const client = {
      async downloadBlob(
        _apiBaseUrl: string,
        _syncToken: string,
        _vaultId: string,
        blobId: string,
      ): Promise<Uint8Array> {
        activeDownloads += 1;
        maxActiveDownloads = Math.max(maxActiveDownloads, activeDownloads);
        downloadOrder.push(blobId);
        if (downloadOrder.length < 3) {
          await new Promise<void>((resolve) => waitForThirdDownload.push(resolve));
        } else {
          releaseThirdDownload();
        }
        activeDownloads -= 1;
        const blob = encryptedBlobs[blobId];
        if (!blob) {
          throw new Error(`missing encrypted blob for ${blobId}`);
        }
        return blob;
      },
    };

    const service = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      vaultAdapter: adapter,
      pullClient: client,
      prepareConcurrency: 3,
      onProgress: ignoreProgress,
    });

    const result = await service.pullOnce(session);

    expect(result.filesWritten).toBe(12);
    expect(maxActiveDownloads).toBe(3);
    expect(downloadOrder.slice(0, 3)).toEqual([
      "blob-1",
      "blob-2",
      "blob-3",
    ]);
    expect(blobIds.map((_, index) => adapter.text(`Folder/note-${index + 1}.md`))).toEqual(
      blobIds.map((blobId) => bodies[blobId]),
    );

    await store.close();
  });

  it("prepares all blobs before writing a large pull", async () => {
    const store = createTestSyncStore();
    const adapter = createVaultAdapter();
    const events: string[] = [];
    const bodies = Array.from({ length: 6 }, (_, index) => `body ${index + 1}`);
    const blobIds = bodies.map((_, index) => `blob-${index + 1}`);
    const encryptedBlobs = Object.fromEntries(
      await Promise.all(
        blobIds.map(async (blobId, index) => [
          blobId,
          await encryptTestBlob(blobId, new TextEncoder().encode(bodies[index])),
        ]),
      ),
    );
    const commits = await Promise.all(
      blobIds.map(async (blobId, index) =>
        createCommit({
          cursor: index + 1,
          entryId: `entry-${index + 1}`,
          revision: 1,
          blobId,
          encryptedMetadata: await encryptRemoteMetadata({
            entryId: `entry-${index + 1}`,
            revision: 1,
            blobId,
            path: `Folder/note-${index + 1}.md`,
            hash: await hashText(bodies[index]),
          }),
        }),
      ),
    );
    const session = createRealtimeSession({
      pages: [
        {
          cursor: 6,
          hasMore: false,
          commits,
        },
      ],
    });
    const client = {
      async downloadBlob(
        _apiBaseUrl: string,
        _syncToken: string,
        _vaultId: string,
        blobId: string,
      ): Promise<Uint8Array> {
        events.push(`download:${blobId}`);
        const blob = encryptedBlobs[blobId];
        if (!blob) {
          throw new Error(`missing encrypted blob for ${blobId}`);
        }
        return blob;
      },
    };
    const recordingAdapter = {
      ...adapter,
      async writeText(path: string, content: string): Promise<void> {
        events.push(`write:${path}`);
        await adapter.writeText(path, content);
      },
    };

    const service = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      vaultAdapter: recordingAdapter,
      pullClient: client,
      prepareConcurrency: 2,
      onProgress: ignoreProgress,
    });

    await expect(service.pullOnce(session)).resolves.toMatchObject({
      cursor: 6,
      filesWritten: 6,
    });
    expect(events.indexOf("write:Folder/note-1.md")).toBeGreaterThan(-1);
    expect(events.indexOf("download:blob-6")).toBeLessThan(
      events.indexOf("write:Folder/note-1.md"),
    );
    expect(blobIds.map((_, index) => adapter.text(`Folder/note-${index + 1}.md`))).toEqual(
      bodies,
    );

    await store.close();
  });
});
