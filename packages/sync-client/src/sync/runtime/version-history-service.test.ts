import { describe, expect, it, vi } from "vitest";

import { hashBytes } from "../core/content";
import { encryptSyncBlob, encryptSyncMetadata } from "../core/crypto";
import type { SyncRealtimeSession } from "../remote/realtime-client";
import { createTestSyncStore } from "../../test-support/in-memory-sync-store";
import {
  SyncVersionHistoryService,
  type SyncVersionHistoryStore,
} from "./version-history-service";

const TEST_VAULT_KEY = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1));

describe("SyncVersionHistoryService", () => {
  it("does not request remote history for local-only entries", async () => {
    const store = createTestSyncStore();
    await store.applyLocalState({
      entryId: "entry-local",
      path: "local-only.md",
      blobId: "blob-local",
      hash: "hash-local",
      deleted: false,
      updatedAt: Date.now(),
      localMtime: null,
      localSize: null,
    });
    const withRealtimeSession = vi.fn();
    const service = createService(store, { withRealtimeSession });

    await expect(
      service.listEntryVersionsForPath("local-only.md", null, 25),
    ).resolves.toBeNull();
    expect(withRealtimeSession).not.toHaveBeenCalled();

    await store.close();
  });

  it("lists server deleted entries as decrypted pages", async () => {
    const store = createTestSyncStore();
    const encryptedMetadata = await encryptSyncMetadata(
      TEST_VAULT_KEY,
      {
        path: "Folder/deleted.md",
        hash: null,
      },
      {
        entryId: "entry-deleted",
        revision: 3,
        op: "delete",
        blobId: null,
      },
    );
    const listDeletedEntries = vi.fn(async () => ({
      entries: [
        {
          entryId: "entry-deleted",
          revision: 3,
          encryptedMetadata,
          deletedAt: 30,
        },
      ],
      hasMore: true,
      nextBefore: { deletedAt: 30, entryId: "entry-deleted" },
    }));
    const service = createService(store, {
      withRealtimeSession: async (work) =>
        await work(createRealtimeSession({ listDeletedEntries })),
    });

    await expect(
      service.listDeletedEntries({ deletedAt: 40, entryId: "entry-before" }, 25),
    ).resolves.toEqual({
      entries: [
        {
          entryId: "entry-deleted",
          path: "Folder/deleted.md",
          revision: 3,
          deletedAt: 30,
        },
      ],
      hasMore: true,
      nextBefore: { deletedAt: 30, entryId: "entry-deleted" },
    });
    expect(listDeletedEntries).toHaveBeenCalledWith({
      before: { deletedAt: 40, entryId: "entry-before" },
      limit: 25,
    });

    await store.close();
  });

  it("restores deleted entries from their newest upsert version", async () => {
    const store = createTestSyncStore();
    const versionMetadata = await encryptSyncMetadata(
      TEST_VAULT_KEY,
      {
        path: "Folder/deleted.md",
        hash: "hash-old",
      },
      {
        entryId: "entry-deleted",
        revision: 2,
        op: "upsert",
        blobId: "blob-old",
      },
    );
    const restoreEntryVersions = vi.fn(async () => ({
      cursor: 4,
      results: [
        {
          status: "accepted" as const,
          entryId: "entry-deleted",
          restoredFromVersionId: "version-old",
          restoredFromRevision: 2,
          cursor: 4,
          revision: 4,
        },
      ],
    }));
    const session = createRealtimeSession({
      listEntryVersions: async () => ({
        entryId: "entry-deleted",
        versions: [
          {
            versionId: "version-delete",
            sourceRevision: 3,
            op: "delete",
            blobId: null,
            encryptedMetadata: "delete-metadata",
            reason: "before_restore",
            capturedAt: 300,
          },
          {
            versionId: "version-old",
            sourceRevision: 2,
            op: "upsert",
            blobId: "blob-old",
            encryptedMetadata: versionMetadata,
            reason: "before_delete",
            capturedAt: 200,
          },
        ],
        hasMore: false,
        nextBefore: null,
      }),
      restoreEntryVersions,
    });
    const pullOnce = vi.fn();
    const service = createService(store, {
      pullOnce,
      withRealtimeSession: async (work) => await work(session),
    });

    await expect(
      service.restoreDeletedEntries([{ entryId: "entry-deleted", revision: 3 }]),
    ).resolves.toEqual({
      restored: 1,
      failures: [],
    });

    expect(restoreEntryVersions).toHaveBeenCalledWith([
      expect.objectContaining({
        entryId: "entry-deleted",
        versionId: "version-old",
        baseRevision: 3,
        op: "upsert",
        blobId: "blob-old",
      }),
    ]);
    expect(pullOnce).toHaveBeenCalledWith(session);

    await store.close();
  });

  it("purges deleted entries through the realtime session", async () => {
    const store = createTestSyncStore();
    const purgeDeletedEntries = vi.fn(async () => ({
      results: [
        {
          status: "accepted" as const,
          entryId: "entry-purged",
        },
        {
          status: "rejected" as const,
          entryId: "entry-failed",
          code: "stale_revision",
          message: "expected revision 4 but received 3",
          expectedRevision: 4,
        },
      ],
    }));
    const service = createService(store, {
      withRealtimeSession: async (work) =>
        await work(createRealtimeSession({ purgeDeletedEntries })),
    });

    await expect(
      service.purgeDeletedEntries([
        { entryId: "entry-purged", revision: 3 },
        { entryId: "entry-failed", revision: 3 },
      ]),
    ).resolves.toEqual({
      purged: 1,
      failures: [
        {
          entryId: "entry-failed",
          message: "expected revision 4 but received 3",
        },
      ],
    });
    expect(purgeDeletedEntries).toHaveBeenCalledWith([
      { entryId: "entry-purged", revision: 3 },
      { entryId: "entry-failed", revision: 3 },
    ]);

    await store.close();
  });

  it("continues restoring deleted entries when one payload cannot be prepared", async () => {
    const store = createTestSyncStore();
    const goodVersion = await createEntryVersion({
      entryId: "entry-good",
      sourceRevision: 2,
      versionId: "version-good",
      path: "Folder/good.md",
    });
    const restoreEntryVersions = vi.fn(async () => ({
      cursor: 4,
      results: [
        {
          status: "accepted" as const,
          entryId: "entry-good",
          restoredFromVersionId: "version-good",
          restoredFromRevision: 2,
          cursor: 4,
          revision: 4,
        },
      ],
    }));
    const listEntryVersions = vi.fn(async ({ entryId }: { entryId: string }) => ({
      entryId,
      versions:
        entryId === "entry-good"
          ? [goodVersion]
          : [
              {
                versionId: "version-bad",
                sourceRevision: 2,
                op: "upsert" as const,
                blobId: "blob-old",
                encryptedMetadata: "not encrypted metadata",
                reason: "before_delete" as const,
                capturedAt: 200,
              },
            ],
      hasMore: false,
      nextBefore: null,
    }));
    const session = createRealtimeSession({
      listEntryVersions,
      restoreEntryVersions,
    });
    const pullOnce = vi.fn();
    const service = createService(store, {
      pullOnce,
      withRealtimeSession: async (work) => await work(session),
    });

    await expect(
      service.restoreDeletedEntries([
        { entryId: "entry-bad", revision: 3 },
        { entryId: "entry-good", revision: 3 },
      ]),
    ).resolves.toMatchObject({
      restored: 1,
      failures: [
        {
          entryId: "entry-bad",
        },
      ],
    });

    expect(restoreEntryVersions).toHaveBeenCalledWith([
      expect.objectContaining({
        entryId: "entry-good",
        versionId: "version-good",
      }),
    ]);
    expect(pullOnce).toHaveBeenCalledWith(session);

    await store.close();
  });

  it("blocks active file version restore while the entry has local changes", async () => {
    const store = createTestSyncStore();
    await store.upsertEntry({
      entryId: "entry-active",
      path: "Folder/active.md",
      revision: 3,
      blobId: "blob-current",
      hash: "hash-current",
      deleted: false,
      updatedAt: 30,
      localMtime: null,
      localSize: null,
    });
    await store.markEntryDirty({
      mutationId: "mutation-active",
      entryId: "entry-active",
      op: "upsert",
      baseRevision: 3,
      baseBlobId: "blob-current",
      baseHash: "hash-current",
      blobId: "blob-local",
      hash: "hash-local",
      encryptedMetadata: "local-metadata",
      createdAt: 40,
    });
    const restoreEntryVersion = vi.fn();
    const session = createRealtimeSession({ restoreEntryVersion });
    const service = createService(store, {
      withRealtimeSession: async (work) => await work(session),
    });

    await expect(
      service.restoreEntryVersionForPath(
        "Folder/active.md",
        await createEntryVersion({
          entryId: "entry-active",
          sourceRevision: 2,
          versionId: "version-old",
        }),
      ),
    ).rejects.toThrow();
    expect(restoreEntryVersion).not.toHaveBeenCalled();

    await store.close();
  });

  it("previews an active upsert version as verified text", async () => {
    const store = createTestSyncStore();
    await store.upsertEntry({
      entryId: "entry-active",
      path: "Folder/active.md",
      revision: 3,
      blobId: "blob-current",
      hash: "hash-current",
      deleted: false,
      updatedAt: 30,
      localMtime: null,
      localSize: null,
    });
    const body = "old body\nwith two lines";
    const version = await createEntryVersion({
      entryId: "entry-active",
      sourceRevision: 2,
      versionId: "version-old",
      body,
    });
    const pullClient = createPullClient({
      "blob-old": await encryptSyncBlob(TEST_VAULT_KEY, new TextEncoder().encode(body), {
        blobId: "blob-old",
      }),
    });
    const service = createService(store, { pullClient });

    await expect(
      service.previewEntryVersionForPath("Folder/active.md", version),
    ).resolves.toEqual({
      status: "text",
      path: "Folder/active.md",
      reason: "before_delete",
      capturedAt: 200,
      text: body,
    });

    await store.close();
  });

  it("previews an active image version as verified image bytes", async () => {
    const store = createTestSyncStore();
    await store.upsertEntry({
      entryId: "entry-active",
      path: "Images/photo.png",
      revision: 3,
      blobId: "blob-current",
      hash: "hash-current",
      deleted: false,
      updatedAt: 30,
      localMtime: null,
      localSize: null,
    });
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
    ]);
    const version = await createEntryVersion({
      entryId: "entry-active",
      sourceRevision: 2,
      versionId: "version-old",
      path: "Images/photo.png",
      bytes,
    });
    const pullClient = createPullClient({
      "blob-old": await encryptSyncBlob(TEST_VAULT_KEY, bytes, {
        blobId: "blob-old",
      }),
    });
    const service = createService(store, { pullClient });

    await expect(
      service.previewEntryVersionForPath("Images/photo.png", version),
    ).resolves.toEqual({
      status: "image",
      path: "Images/photo.png",
      reason: "before_delete",
      capturedAt: 200,
      mimeType: "image/png",
      bytes,
    });

    await store.close();
  });

  it("previews a deleted file from its newest upsert version", async () => {
    const store = createTestSyncStore();
    await store.upsertEntry({
      entryId: "entry-deleted",
      path: "Folder/deleted.md",
      revision: 3,
      blobId: null,
      hash: null,
      deleted: true,
      updatedAt: 30,
      localMtime: null,
      localSize: null,
    });
    const body = "deleted body";
    const version = await createEntryVersion({
      entryId: "entry-deleted",
      sourceRevision: 2,
      versionId: "version-old",
      path: "Folder/deleted.md",
      body,
    });
    const session = createRealtimeSession({
      listEntryVersions: async () => ({
        entryId: "entry-deleted",
        versions: [
          {
            versionId: "version-delete",
            sourceRevision: 3,
            op: "delete",
            blobId: null,
            encryptedMetadata: "delete-metadata",
            reason: "before_restore",
            capturedAt: 300,
          },
          version,
        ],
        hasMore: false,
        nextBefore: null,
      }),
    });
    const service = createService(store, {
      pullClient: createPullClient({
        "blob-old": await encryptSyncBlob(TEST_VAULT_KEY, new TextEncoder().encode(body), {
          blobId: "blob-old",
        }),
      }),
      withRealtimeSession: async (work) => await work(session),
    });

    await expect(
      service.previewDeletedEntry("entry-deleted", "Folder/deleted.md"),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "text",
        path: "Folder/deleted.md",
        text: body,
      }),
    );

    await store.close();
  });

  it("returns unavailable preview when a deleted file has no upsert version", async () => {
    const store = createTestSyncStore();
    await store.upsertEntry({
      entryId: "entry-deleted",
      path: "Folder/deleted.md",
      revision: 3,
      blobId: null,
      hash: null,
      deleted: true,
      updatedAt: 30,
      localMtime: null,
      localSize: null,
    });
    const session = createRealtimeSession({
      listEntryVersions: async () => ({
        entryId: "entry-deleted",
        versions: [
          {
            versionId: "version-delete",
            sourceRevision: 3,
            op: "delete",
            blobId: null,
            encryptedMetadata: "delete-metadata",
            reason: "before_restore",
            capturedAt: 300,
          },
        ],
        hasMore: false,
        nextBefore: null,
      }),
    });
    const service = createService(store, {
      withRealtimeSession: async (work) => await work(session),
    });

    await expect(
      service.previewDeletedEntry("entry-deleted", "Folder/deleted.md"),
    ).resolves.toMatchObject({
      status: "unavailable",
      path: "Folder/deleted.md",
      reason: null,
      capturedAt: null,
      message: expect.any(String),
    });

    await store.close();
  });

  it("returns unavailable preview for a version without a blob", async () => {
    const store = createTestSyncStore();
    await store.upsertEntry({
      entryId: "entry-active",
      path: "Folder/active.md",
      revision: 3,
      blobId: "blob-current",
      hash: "hash-current",
      deleted: false,
      updatedAt: 30,
      localMtime: null,
      localSize: null,
    });
    const service = createService(store);

    await expect(
      service.previewEntryVersionForPath("Folder/active.md", {
        versionId: "version-delete",
        sourceRevision: 2,
        op: "delete",
        blobId: null,
        encryptedMetadata: "delete-metadata",
        reason: "before_delete",
        capturedAt: 200,
      }),
    ).resolves.toMatchObject({
      status: "unavailable",
      path: "Folder/active.md",
      reason: "before_delete",
      capturedAt: 200,
      message: expect.any(String),
    });

    await store.close();
  });

  it("rejects active preview when the downloaded blob hash mismatches metadata", async () => {
    const store = createTestSyncStore();
    await store.upsertEntry({
      entryId: "entry-active",
      path: "Folder/active.md",
      revision: 3,
      blobId: "blob-current",
      hash: "hash-current",
      deleted: false,
      updatedAt: 30,
      localMtime: null,
      localSize: null,
    });
    const version = await createEntryVersion({
      entryId: "entry-active",
      sourceRevision: 2,
      versionId: "version-old",
      body: "expected body",
    });
    const service = createService(store, {
      pullClient: createPullClient({
        "blob-old": await encryptSyncBlob(
          TEST_VAULT_KEY,
          new TextEncoder().encode("different body"),
          { blobId: "blob-old" },
        ),
      }),
    });

    await expect(
      service.previewEntryVersionForPath("Folder/active.md", version),
    ).rejects.toThrow();

    await store.close();
  });

  it("rejects active preview when blob download fails", async () => {
    const store = createTestSyncStore();
    await store.upsertEntry({
      entryId: "entry-active",
      path: "Folder/active.md",
      revision: 3,
      blobId: "blob-current",
      hash: "hash-current",
      deleted: false,
      updatedAt: 30,
      localMtime: null,
      localSize: null,
    });
    const version = await createEntryVersion({
      entryId: "entry-active",
      sourceRevision: 2,
      versionId: "version-old",
    });
    const service = createService(store, {
      pullClient: {
        async downloadBlob() {
          throw new Error("download failed");
        },
      },
    });

    await expect(
      service.previewEntryVersionForPath("Folder/active.md", version),
    ).rejects.toThrow("download failed");

    await store.close();
  });

  it("throws when a deleted entry has no restorable upsert version", async () => {
    const store = createTestSyncStore();
    await store.upsertEntry({
      entryId: "entry-deleted",
      path: "Folder/deleted.md",
      revision: 3,
      blobId: null,
      hash: null,
      deleted: true,
      updatedAt: 30,
      localMtime: null,
      localSize: null,
    });
    const restoreEntryVersions = vi.fn();
    const session = createRealtimeSession({
      listEntryVersions: async () => ({
        entryId: "entry-deleted",
        versions: [
          {
            versionId: "version-delete",
            sourceRevision: 3,
            op: "delete",
            blobId: null,
            encryptedMetadata: "delete-metadata",
            reason: "before_restore",
            capturedAt: 300,
          },
        ],
        hasMore: false,
        nextBefore: null,
      }),
      restoreEntryVersions,
    });
    const service = createService(store, {
      withRealtimeSession: async (work) => await work(session),
    });

    await expect(
      service.restoreDeletedEntries([{ entryId: "entry-deleted", revision: 3 }]),
    ).resolves.toMatchObject({
      restored: 0,
      failures: [
        {
          entryId: "entry-deleted",
          message: expect.any(String),
        },
      ],
    });
    expect(restoreEntryVersions).not.toHaveBeenCalled();

    await store.close();
  });

  it("restores a selected active file version and pulls the restored state", async () => {
    const store = createTestSyncStore();
    await store.upsertEntry({
      entryId: "entry-active",
      path: "Folder/active.md",
      revision: 3,
      blobId: "blob-current",
      hash: "hash-current",
      deleted: false,
      updatedAt: 30,
      localMtime: null,
      localSize: null,
    });
    const restoreEntryVersion = vi.fn(async () => ({
      entryId: "entry-active",
      restoredFromVersionId: "version-old",
      restoredFromRevision: 2,
      cursor: 4,
      revision: 4,
    }));
    const session = createRealtimeSession({ restoreEntryVersion });
    const pullOnce = vi.fn();
    const service = createService(store, {
      pullOnce,
      withRealtimeSession: async (work) => await work(session),
    });

    await service.restoreEntryVersionForPath(
      "Folder/active.md",
      await createEntryVersion({
        entryId: "entry-active",
        sourceRevision: 2,
        versionId: "version-old",
      }),
    );

    expect(restoreEntryVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        entryId: "entry-active",
        versionId: "version-old",
        baseRevision: 3,
        op: "upsert",
        blobId: "blob-old",
      }),
    );
    expect(pullOnce).toHaveBeenCalledWith(session);

    await store.close();
  });
});

function createService(
  store: SyncVersionHistoryStore,
  overrides: Partial<ConstructorParameters<typeof SyncVersionHistoryService>[0]> = {},
): SyncVersionHistoryService {
  return new SyncVersionHistoryService({
    getApiBaseUrl: () => "http://127.0.0.1:8787",
    getSyncToken: async () => ({
      token: "sync-token",
      vaultId: "vault-1",
      localVaultId: "local-vault-1",
      expiresAt: Date.now() + 60_000,
    }),
    getStore: () => store,
    getRemoteVaultKey: () => TEST_VAULT_KEY,
    pullClient: createPullClient({}),
    withRealtimeSession: async (work) => await work(createRealtimeSession({})),
    runLocalMutationWork: async (work) => await work(),
    pullOnce: vi.fn(),
    ...overrides,
  });
}

function createRealtimeSession(
  overrides: Partial<SyncRealtimeSession>,
): SyncRealtimeSession {
  return {
    serverCursor: 0,
    storageUsedBytes: 0,
    storageLimitBytes: 100_000_000,
    maxFileSizeBytes: 3_000_000,
    watchStorageStatus: vi.fn(),
    unwatchStorageStatus: vi.fn(),
    listEntryStates: vi.fn(async () => ({
      targetCursor: 0,
      totalEntries: 0,
      hasMore: false,
      nextAfter: null,
      entries: [],
    })),
    listEntryVersions: vi.fn(),
    listDeletedEntries: vi.fn(async () => ({
      entries: [],
      hasMore: false,
      nextBefore: null,
    })),
    restoreEntryVersion: vi.fn(),
    restoreEntryVersions: vi.fn(async () => ({
      cursor: 0,
      results: [],
    })),
    purgeDeletedEntries: vi.fn(async () => ({
      results: [],
    })),
    commitMutation: vi.fn(),
    commitMutations: vi.fn(),
    close: vi.fn(),
    ...overrides,
  } as unknown as SyncRealtimeSession;
}

async function createEntryVersion(input: {
  entryId: string;
  sourceRevision: number;
  versionId: string;
  path?: string;
  body?: string;
  bytes?: Uint8Array;
}): Promise<{
  versionId: string;
  sourceRevision: number;
  op: "upsert";
  blobId: string;
  encryptedMetadata: string;
  reason: "before_delete";
  capturedAt: number;
}> {
  const body = input.body ?? "old body";
  const bytes = input.bytes ?? new TextEncoder().encode(body);
  return {
    versionId: input.versionId,
    sourceRevision: input.sourceRevision,
    op: "upsert",
    blobId: "blob-old",
    encryptedMetadata: await encryptSyncMetadata(
      TEST_VAULT_KEY,
      {
        path: input.path ?? "Folder/active.md",
        hash: await hashBytes(bytes),
      },
      {
        entryId: input.entryId,
        revision: input.sourceRevision,
        op: "upsert",
        blobId: "blob-old",
      },
    ),
    reason: "before_delete",
    capturedAt: 200,
  };
}

function createPullClient(
  blobs: Record<string, Uint8Array>,
): {
  downloadBlob(
    apiBaseUrl: string,
    syncToken: string,
    vaultId: string,
    blobId: string,
  ): Promise<Uint8Array>;
} {
  return {
    async downloadBlob(_apiBaseUrl, _syncToken, _vaultId, blobId) {
      const blob = blobs[blobId];
      if (!blob) {
        throw new Error(`missing blob fixture for ${blobId}`);
      }
      return blob;
    },
  };
}
