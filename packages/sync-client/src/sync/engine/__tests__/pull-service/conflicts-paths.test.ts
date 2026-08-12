import { describe, expect, it } from "vitest";

import { hashBytes } from "../../../core/content";
import { SyncPullService } from "../../pull-service";
import { createTestSyncStore } from "../../../../test-support/in-memory-sync-store";
import {
  arrangePendingUpsertWithCachedBase,
  createCommit,
  createEventGate,
  createPullClient,
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

describe("SyncPullService path conflicts", () => {
  it("keeps only the latest remote version when vault config entries share a path", async () => {
    const store = createTestSyncStore();
    const path = ".obsidian/graph.json";
    const adapter = {
      ...createVaultAdapter(),
      isProtectedVaultPath: (candidate: string) =>
        candidate.includes(".sync-conflict-"),
    };
    const conflicts: PullConflictSummary[] = [];
    const session = createRealtimeSession({
      pages: [
        {
          cursor: 2,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 1,
              entryId: "entry-old",
              revision: 1,
              blobId: "blob-old",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-old",
                revision: 1,
                blobId: "blob-old",
                path,
                hash: await hashText('{"version":"old"}'),
              }),
            }),
            createCommit({
              cursor: 2,
              entryId: "entry-latest",
              revision: 1,
              blobId: "blob-latest",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-latest",
                revision: 1,
                blobId: "blob-latest",
                path,
                hash: await hashText('{"version":"latest"}'),
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
      shouldUseLatestRemoteVersion: (candidate) => candidate.startsWith(".obsidian/"),
      vaultAdapter: adapter,
      pullClient: createPullClient({
        blobs: {
          "blob-old": await encryptTestBlob(
            "blob-old",
            new TextEncoder().encode('{"version":"old"}'),
          ),
          "blob-latest": await encryptTestBlob(
            "blob-latest",
            new TextEncoder().encode('{"version":"latest"}'),
          ),
        },
      }),
      onProgress: ignoreProgress,
      onConflict: (event) => conflicts.push(event),
      now: conflictTimestamp,
    });

    await expect(service.pullOnce(session)).resolves.toEqual({
      cursor: 2,
      entriesApplied: 2,
      filesWritten: 1,
      filesDeleted: 0,
      conflictsCreated: 0,
    });
    expect(adapter.text(path)).toBe('{"version":"latest"}');
    expect(adapter.text(".obsidian/graph.sync-conflict-20260422-101112.json")).toBeNull();
    expect(await store.getRemoteStateById("entry-old")).toMatchObject({
      path: null,
      revision: 1,
      blobId: "blob-old",
    });
    expect(await store.getEntryById("entry-latest")).toMatchObject({
      path,
      revision: 1,
      blobId: "blob-latest",
    });
    expect(conflicts).toEqual([]);

    await store.close();
  });

  it("keeps the live vault config owner when a previous loser is deleted", async () => {
    const store = createTestSyncStore();
    const path = ".obsidian/graph.json";
    const winnerBody = '{"version":"winner"}';
    const winnerHash = await hashText(winnerBody);
    const adapter = createVaultAdapter({ [path]: winnerBody });
    await store.applyRemoteState({
      entryId: "entry-loser",
      path: null,
      revision: 1,
      blobId: "blob-loser",
      hash: await hashText('{"version":"loser"}'),
      deleted: false,
      updatedAt: 1,
    });
    await store.upsertEntry({
      entryId: "entry-winner",
      path,
      revision: 1,
      blobId: "blob-winner",
      hash: winnerHash,
      deleted: false,
      updatedAt: 2,
    });
    await store.markEntryDirty({
      mutationId: "mutation-winner",
      entryId: "entry-winner",
      op: "upsert",
      baseRevision: 1,
      blobId: "blob-winner-local",
      hash: winnerHash,
      encryptedMetadata: await encryptPendingMetadata({
        entryId: "entry-winner",
        baseRevision: 1,
        op: "upsert",
        blobId: "blob-winner-local",
        path,
        hash: winnerHash,
      }),
      createdAt: 3,
    });

    const session = createRealtimeSession({
      pages: [
        {
          cursor: 4,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 4,
              entryId: "entry-loser",
              op: "delete",
              revision: 2,
              baseRevision: 1,
              blobId: null,
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-loser",
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
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      shouldUseLatestRemoteVersion: (candidate) => candidate.startsWith(".obsidian/"),
      vaultAdapter: adapter,
      pullClient: createPullClient({}),
      onProgress: ignoreProgress,
    });

    await expect(service.pullOnce(session)).resolves.toMatchObject({
      entriesApplied: 1,
      filesWritten: 0,
      filesDeleted: 0,
      conflictsCreated: 0,
    });
    expect(adapter.text(path)).toBe(winnerBody);
    expect(await store.getEntryById("entry-winner")).toMatchObject({
      path,
      deleted: false,
    });
    expect(await store.listDirtyEntries()).toEqual([
      expect.objectContaining({ mutationId: "mutation-winner" }),
    ]);
    expect(await store.getRemoteStateById("entry-loser")).toMatchObject({
      path,
      revision: 2,
      deleted: true,
    });

    await store.close();
  });

  it("keeps a live vault config upsert when another entry is deleted in the same window", async () => {
    const store = createTestSyncStore();
    const path = ".obsidian/graph.json";
    const liveBody = '{"version":"live"}';
    const adapter = createVaultAdapter();
    const session = createRealtimeSession({
      pages: [
        {
          cursor: 2,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 1,
              entryId: "entry-live",
              revision: 1,
              blobId: "blob-live",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-live",
                revision: 1,
                blobId: "blob-live",
                path,
                hash: await hashText(liveBody),
              }),
            }),
            createCommit({
              cursor: 2,
              entryId: "entry-deleted",
              op: "delete",
              revision: 2,
              baseRevision: 1,
              blobId: null,
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-deleted",
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
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      shouldUseLatestRemoteVersion: (candidate) => candidate.startsWith(".obsidian/"),
      vaultAdapter: adapter,
      pullClient: createPullClient({
        blobs: {
          "blob-live": await encryptTestBlob(
            "blob-live",
            new TextEncoder().encode(liveBody),
          ),
        },
      }),
      onProgress: ignoreProgress,
    });

    await expect(service.pullOnce(session)).resolves.toMatchObject({
      entriesApplied: 2,
      filesWritten: 1,
      filesDeleted: 0,
      conflictsCreated: 0,
    });
    expect(adapter.text(path)).toBe(liveBody);
    expect(await store.getEntryById("entry-live")).toMatchObject({
      path,
      deleted: false,
    });
    expect(await store.getRemoteStateById("entry-deleted")).toMatchObject({
      path,
      revision: 2,
      deleted: true,
    });

    await store.close();
  });

  it("deletes a vault config path when its current owner is deleted", async () => {
    const store = createTestSyncStore();
    const path = ".obsidian/graph.json";
    const body = '{"version":"current"}';
    const adapter = createVaultAdapter({ [path]: body });
    await store.upsertEntry({
      entryId: "entry-current",
      path,
      revision: 1,
      blobId: "blob-current",
      hash: await hashText(body),
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
              entryId: "entry-current",
              op: "delete",
              revision: 2,
              baseRevision: 1,
              blobId: null,
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-current",
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
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      shouldUseLatestRemoteVersion: (candidate) => candidate.startsWith(".obsidian/"),
      vaultAdapter: adapter,
      pullClient: createPullClient({}),
      onProgress: ignoreProgress,
    });

    await expect(service.pullOnce(session)).resolves.toMatchObject({
      entriesApplied: 1,
      filesWritten: 0,
      filesDeleted: 1,
      conflictsCreated: 0,
    });
    expect(adapter.text(path)).toBeNull();
    expect(await store.getEntryById("entry-current")).toMatchObject({
      path,
      revision: 2,
      deleted: true,
    });

    await store.close();
  });

  it("removes the previous path of a superseded vault config entry", async () => {
    const store = createTestSyncStore();
    const previousPath = ".obsidian/old-graph.json";
    const sharedPath = ".obsidian/graph.json";
    const previousBody = '{"version":"previous"}';
    const supersededBody = '{"version":"superseded"}';
    const latestBody = '{"version":"latest"}';
    const adapter = createVaultAdapter({ [previousPath]: previousBody });
    await store.upsertEntry({
      entryId: "entry-superseded",
      path: previousPath,
      revision: 1,
      blobId: "blob-previous",
      hash: await hashText(previousBody),
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
              entryId: "entry-superseded",
              revision: 2,
              blobId: "blob-superseded",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-superseded",
                revision: 2,
                blobId: "blob-superseded",
                path: sharedPath,
                hash: await hashText(supersededBody),
              }),
            }),
            createCommit({
              cursor: 3,
              entryId: "entry-latest",
              revision: 1,
              blobId: "blob-latest",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-latest",
                revision: 1,
                blobId: "blob-latest",
                path: sharedPath,
                hash: await hashText(latestBody),
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
      shouldUseLatestRemoteVersion: (candidate) => candidate.startsWith(".obsidian/"),
      vaultAdapter: adapter,
      pullClient: createPullClient({
        blobs: {
          "blob-latest": await encryptTestBlob(
            "blob-latest",
            new TextEncoder().encode(latestBody),
          ),
        },
      }),
      onProgress: ignoreProgress,
    });

    await expect(service.pullOnce(session)).resolves.toMatchObject({
      entriesApplied: 2,
      filesWritten: 1,
      filesDeleted: 1,
      conflictsCreated: 0,
    });
    expect(adapter.text(previousPath)).toBeNull();
    expect(adapter.text(sharedPath)).toBe(latestBody);
    expect(await store.getRemoteStateById("entry-superseded")).toMatchObject({
      path: null,
      revision: 2,
    });

    await store.close();
  });

  it("rejects an invalid superseded vault config state", async () => {
    const store = createTestSyncStore();
    const path = ".obsidian/graph.json";
    const latestBody = '{"version":"latest"}';
    const adapter = createVaultAdapter();
    const session = createRealtimeSession({
      pages: [
        {
          cursor: 2,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 1,
              entryId: "entry-invalid",
              revision: 1,
              blobId: null,
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-invalid",
                revision: 1,
                blobId: null,
                path,
                hash: await hashText('{"version":"invalid"}'),
              }),
            }),
            createCommit({
              cursor: 2,
              entryId: "entry-latest",
              revision: 1,
              blobId: "blob-latest",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-latest",
                revision: 1,
                blobId: "blob-latest",
                path,
                hash: await hashText(latestBody),
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
      shouldUseLatestRemoteVersion: (candidate) => candidate.startsWith(".obsidian/"),
      vaultAdapter: adapter,
      pullClient: createPullClient({}),
      onProgress: ignoreProgress,
    });

    await expect(service.pullOnce(session)).rejects.toThrow();
    expect(adapter.text(path)).toBeNull();
    expect(await store.getRemoteStateById("entry-invalid")).toBeNull();
    expect(await store.getCursor()).toBe(0);

    await store.close();
  });

  it("replaces an older tracked vault config path owner with the latest remote entry", async () => {
    const store = createTestSyncStore();
    const path = ".obsidian/graph.json";
    const oldBody = '{"version":"old"}';
    const latestBody = '{"version":"latest"}';
    const adapter = createVaultAdapter({ [path]: oldBody });
    await store.upsertEntry({
      entryId: "entry-old",
      path,
      revision: 1,
      blobId: "blob-old",
      hash: await hashText(oldBody),
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
              entryId: "entry-latest",
              revision: 1,
              blobId: "blob-latest",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-latest",
                revision: 1,
                blobId: "blob-latest",
                path,
                hash: await hashText(latestBody),
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
      shouldUseLatestRemoteVersion: (candidate) => candidate.startsWith(".obsidian/"),
      vaultAdapter: adapter,
      pullClient: createPullClient({
        blobs: {
          "blob-latest": await encryptTestBlob(
            "blob-latest",
            new TextEncoder().encode(latestBody),
          ),
        },
      }),
      onProgress: ignoreProgress,
    });

    await expect(service.pullOnce(session)).resolves.toMatchObject({
      entriesApplied: 1,
      filesWritten: 1,
      conflictsCreated: 0,
    });
    expect(adapter.text(path)).toBe(latestBody);
    expect(await store.getRemoteStateById("entry-old")).toMatchObject({ path: null });
    expect(await store.getEntryById("entry-latest")).toMatchObject({ path });

    await store.close();
  });

  it("adopts an unpushed local entry when the same remote path has identical content", async () => {
    const store = createTestSyncStore();
    const body = "same body";
    const hash = await hashText(body);
    const adapter = createVaultAdapter({
      "Folder/shared.md": body,
    });
    await store.upsertEntry({
      entryId: "entry-local",
      path: "Folder/shared.md",
      revision: 0,
      blobId: "blob-local",
      hash,
      deleted: false,
      updatedAt: 1,
      localMtime: 123,
      localSize: body.length,
    });
    await store.markEntryDirty({
      mutationId: "mutation-local",
      entryId: "entry-local",
      op: "upsert",
      baseRevision: 0,
      blobId: "blob-local",
      hash,
      encryptedMetadata: await encryptPendingMetadata({
        entryId: "entry-local",
        baseRevision: 0,
        op: "upsert",
        blobId: "blob-local",
        path: "Folder/shared.md",
        hash,
      }),
      createdAt: 2,
    });

    const conflicts: PullConflictSummary[] = [];
    const session = createRealtimeSession({
      pages: [
        {
          cursor: 2,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 2,
              entryId: "entry-remote",
              revision: 1,
              blobId: "blob-remote",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-remote",
                revision: 1,
                blobId: "blob-remote",
                path: "Folder/shared.md",
                hash,
              }),
            }),
          ],
        },
      ],
    });
    const client = createPullClient({
      blobs: {
        "blob-remote": await encryptTestBlob("blob-remote", new TextEncoder().encode(body)),
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
      cursor: 2,
      entriesApplied: 1,
      filesWritten: 0,
      filesDeleted: 0,
      conflictsCreated: 0,
    });
    expect(adapter.text("Folder/shared.md")).toBe(body);
    expect(adapter.text("Folder/shared.sync-conflict-20260422-101112.md")).toBeNull();
    expect(await store.getEntryById("entry-local")).toBeNull();
    expect(await store.getEntryById("entry-remote")).toMatchObject({
      entryId: "entry-remote",
      path: "Folder/shared.md",
      revision: 1,
      hash,
      localMtime: 123,
      localSize: body.length,
    });
    expect(await store.getBlob("blob-remote")).toMatchObject({
      blobId: "blob-remote",
      hash,
    });
    expect(await store.listDirtyEntries()).toEqual([]);
    expect(conflicts).toEqual([]);

    await store.close();
  });

  it("writes duplicate adopted remote paths to conflict copies", async () => {
    const store = createTestSyncStore();
    const body = "same body";
    const hash = await hashText(body);
    const adapter = createVaultAdapter({
      "Folder/shared.md": body,
    });
    await store.upsertEntry({
      entryId: "entry-local",
      path: "Folder/shared.md",
      revision: 0,
      blobId: "blob-local",
      hash,
      deleted: false,
      updatedAt: 1,
      localMtime: 123,
      localSize: body.length,
    });
    await store.markEntryDirty({
      mutationId: "mutation-local",
      entryId: "entry-local",
      op: "upsert",
      baseRevision: 0,
      blobId: "blob-local",
      hash,
      encryptedMetadata: await encryptPendingMetadata({
        entryId: "entry-local",
        baseRevision: 0,
        op: "upsert",
        blobId: "blob-local",
        path: "Folder/shared.md",
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
              cursor: 2,
              entryId: "entry-remote-a",
              revision: 1,
              blobId: "blob-remote-a",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-remote-a",
                revision: 1,
                blobId: "blob-remote-a",
                path: "Folder/shared.md",
                hash,
              }),
            }),
            createCommit({
              cursor: 3,
              entryId: "entry-remote-b",
              revision: 1,
              blobId: "blob-remote-b",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-remote-b",
                revision: 1,
                blobId: "blob-remote-b",
                path: "Folder/shared.md",
                hash,
              }),
            }),
          ],
        },
      ],
    });
    const client = createPullClient({
      blobs: {
        "blob-remote-a": await encryptTestBlob(
          "blob-remote-a",
          new TextEncoder().encode(body),
        ),
        "blob-remote-b": await encryptTestBlob(
          "blob-remote-b",
          new TextEncoder().encode(body),
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
      entriesApplied: 2,
      filesWritten: 1,
      filesDeleted: 0,
      conflictsCreated: 1,
    });
    expect(adapter.text("Folder/shared.md")).toBe(body);
    expect(adapter.text("Folder/shared.sync-conflict-20260422-101112.md")).toBe(body);
    expect((await store.getEntryById("entry-remote-a"))?.path).toBe("Folder/shared.md");
    expect((await store.getEntryById("entry-remote-b"))?.path).toBe(
      "Folder/shared.sync-conflict-20260422-101112.md",
    );
    expect(await store.listDirtyEntries()).toEqual([]);
    expect(conflicts).toEqual([
      {
        entryId: "entry-remote-b",
        reason: "remote_path_collision",
        originalPath: "Folder/shared.md",
        conflictPath: "Folder/shared.sync-conflict-20260422-101112.md",
      },
    ]);

    await store.close();
  });

  it("adopts the remote identity but preserves differing unpushed local content as a conflict copy", async () => {
    const store = createTestSyncStore();
    const localHash = await hashText("local body");
    const remoteHash = await hashText("remote body");
    const adapter = createVaultAdapter({
      "Folder/shared.md": "local body",
    });
    await store.upsertEntry({
      entryId: "entry-local",
      path: "Folder/shared.md",
      revision: 0,
      blobId: "blob-local",
      hash: localHash,
      deleted: false,
      updatedAt: 1,
    });
    await store.markEntryDirty({
      mutationId: "mutation-local",
      entryId: "entry-local",
      op: "upsert",
      baseRevision: 0,
      blobId: "blob-local",
      hash: localHash,
      encryptedMetadata: await encryptPendingMetadata({
        entryId: "entry-local",
        baseRevision: 0,
        op: "upsert",
        blobId: "blob-local",
        path: "Folder/shared.md",
        hash: localHash,
      }),
      createdAt: 2,
    });

    const conflicts: PullConflictSummary[] = [];
    const session = createRealtimeSession({
      pages: [
        {
          cursor: 2,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 2,
              entryId: "entry-remote",
              revision: 1,
              blobId: "blob-remote",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-remote",
                revision: 1,
                blobId: "blob-remote",
                path: "Folder/shared.md",
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
          new TextEncoder().encode("remote body"),
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
      cursor: 2,
      entriesApplied: 1,
      filesWritten: 1,
      filesDeleted: 0,
      conflictsCreated: 1,
    });
    expect(adapter.text("Folder/shared.md")).toBe("remote body");
    expect(adapter.text("Folder/shared.sync-conflict-20260422-101112.md")).toBe(
      "local body",
    );
    expect(await store.getEntryById("entry-local")).toBeNull();
    expect(await store.getEntryById("entry-remote")).toMatchObject({
      entryId: "entry-remote",
      path: "Folder/shared.md",
      revision: 1,
      hash: remoteHash,
    });
    expect(await store.listDirtyEntries()).toEqual([]);
    expect(conflicts).toEqual([
      {
        entryId: "entry-local",
        reason: "local_pending_mutation",
        originalPath: "Folder/shared.md",
        conflictPath: "Folder/shared.sync-conflict-20260422-101112.md",
      },
    ]);

    await store.close();
  });

  it("materializes same-path remote entries as conflict copies", async () => {
    const store = createTestSyncStore();
    const adapter = createVaultAdapter();
    const suppressionCalls: string[][] = [];
    const conflicts: PullConflictSummary[] = [];
    const session = createRealtimeSession({
      pages: [
        {
          cursor: 2,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 1,
              entryId: "entry-a",
              revision: 1,
              blobId: "blob-a",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-a",
                revision: 1,
                blobId: "blob-a",
                path: "Folder/shared.md",
                hash: await hashText("first body"),
              }),
            }),
            createCommit({
              cursor: 2,
              entryId: "entry-b",
              revision: 1,
              blobId: "blob-b",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-b",
                revision: 1,
                blobId: "blob-b",
                path: "Folder/shared.md",
                hash: await hashText("second body"),
              }),
            }),
          ],
        },
      ],
    });
    const client = createPullClient({
      blobs: {
        "blob-a": await encryptTestBlob("blob-a", new TextEncoder().encode("first body")),
        "blob-b": await encryptTestBlob("blob-b", new TextEncoder().encode("second body")),
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
      cursor: 2,
      entriesApplied: 2,
      filesWritten: 2,
      filesDeleted: 0,
      conflictsCreated: 1,
    });
    expect(adapter.text("Folder/shared.md")).toBe("first body");
    expect(adapter.text("Folder/shared.sync-conflict-20260422-101112.md")).toBe(
      "second body",
    );
    expect((await store.getEntryById("entry-a"))?.path).toBe("Folder/shared.md");
    expect((await store.getEntryById("entry-b"))?.path).toBe(
      "Folder/shared.sync-conflict-20260422-101112.md",
    );
    expect(await store.getCursor()).toBe(2);
    expect(conflicts).toEqual([
      {
        entryId: "entry-b",
        reason: "remote_path_collision",
        originalPath: "Folder/shared.md",
        conflictPath: "Folder/shared.sync-conflict-20260422-101112.md",
      },
    ]);
    expect(suppressionCalls).toEqual([
      ["Folder/shared.md", "Folder/shared.sync-conflict-20260422-101112.md"],
    ]);

    await store.close();
  });

  it("keeps pending local edits when remote path collisions are diverted", async () => {
    const store = createTestSyncStore();
    const adapter = createVaultAdapter({
      "Folder/shared.md": "local pending body",
    });
    const conflicts: PullConflictSummary[] = [];
    await store.upsertEntry({
      entryId: "entry-a",
      path: "Folder/shared.md",
      revision: 1,
      blobId: "blob-a",
      hash: "local-hash",
      deleted: false,
      updatedAt: 1,
    });
    await store.markEntryDirty({
      mutationId: "mutation-a",
      entryId: "entry-a",
      op: "upsert",
      baseRevision: 1,
      blobId: "blob-local",
      hash: "local-hash",
      encryptedMetadata: await encryptPendingMetadata({
        entryId: "entry-a",
        baseRevision: 1,
        op: "upsert",
        blobId: "blob-local",
        path: "Folder/shared.md",
        hash: "local-hash",
      }),
      createdAt: 2,
    });

    const session = createRealtimeSession({
      pages: [
        {
          cursor: 2,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 2,
              entryId: "entry-b",
              revision: 1,
              blobId: "blob-b",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-b",
                revision: 1,
                blobId: "blob-b",
                path: "Folder/shared.md",
                hash: await hashText("remote body"),
              }),
            }),
          ],
        },
      ],
    });
    const client = createPullClient({
      blobs: {
        "blob-b": await encryptTestBlob("blob-b", new TextEncoder().encode("remote body")),
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
      cursor: 2,
      entriesApplied: 1,
      filesWritten: 1,
      filesDeleted: 0,
      conflictsCreated: 1,
    });
    expect(adapter.text("Folder/shared.md")).toBe("local pending body");
    expect(adapter.text("Folder/shared.sync-conflict-20260422-101112.md")).toBe(
      "remote body",
    );
    expect(await store.listDirtyEntries()).toMatchObject([
      {
        mutationId: "mutation-a",
        entryId: "entry-a",
      },
    ]);
    expect(conflicts).toEqual([
      {
        entryId: "entry-b",
        reason: "remote_path_collision",
        originalPath: "Folder/shared.md",
        conflictPath: "Folder/shared.sync-conflict-20260422-101112.md",
      },
    ]);

    await store.close();
  });
});
