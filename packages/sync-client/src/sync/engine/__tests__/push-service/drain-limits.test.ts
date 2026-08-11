import { describe, expect, it, vi } from "vitest";

import { encodeUtf8, hashBytes } from "../../../core/content";
import { SyncBlobUploadError } from "../../../remote/blob-client";
import type { CommitMutationPayload } from "../../../remote/realtime-client";
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

describe("SyncPushService drain: limits", () => {
  it("blocks upserts whose encrypted blob exceeds the server file size limit", async () => {
    const store = createTestSyncStore();
    const bytes = encodeUtf8("new body");
    const hash = await hashBytes(bytes);
    await store.upsertEntry({
      entryId: "entry-too-large",
      path: "Folder/too-large.md",
      revision: 0,
      blobId: "blob-too-large",
      hash,
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: bytes.byteLength,
    });
    await store.markEntryDirty({
      mutationId: "mutation-too-large",
      entryId: "entry-too-large",
      op: "upsert",
      baseRevision: 0,
      blobId: "blob-too-large",
      hash,
      encryptedMetadata: await encryptMutationMetadata({
        entryId: "entry-too-large",
        baseRevision: 0,
        op: "upsert",
        blobId: "blob-too-large",
        path: "Folder/too-large.md",
        hash,
      }),
      createdAt: 1,
    });

    const session = createPushSession(async () => {
      throw new Error("oversized mutation should not be committed");
    });
    session.maxFileSizeBytes = 1;
    let uploaded = false;
    const onFileSizeBlockedFilesChange = vi.fn();
    const service = new SyncPushService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      fileReader: {
        async readBytes(path) {
          if (path === "Folder/too-large.md") {
            return bytes;
          }

          throw new Error(`unexpected read for ${path}`);
        },
      },
      blobClient: {
        async uploadBlob() {
          uploaded = true;
        },
      },
      onProgress: ignoreProgress,
      onFileSizeBlockedFilesChange,
    });

    await expect(service.pushPendingMutations(session)).resolves.toEqual({
      cursor: 0,
      mutationsPushed: 0,
      mutationsRequeued: 0,
      filesCreatedOrUpdated: 0,
      filesDeleted: 0,
      conflictsCreated: 0,
      shouldPullAfterPush: false,
      hasMore: false,
    });
    expect(onFileSizeBlockedFilesChange).toHaveBeenCalledTimes(1);
    expect(uploaded).toBe(false);
    expect(await store.listDirtyEntries()).toEqual([]);
    expect(await store.getDirtyEntryMutation("entry-too-large")).toMatchObject({
      mutationId: "mutation-too-large",
      status: "blocked",
      blockedReason: "file_too_large",
      blockedEncryptedSizeBytes: expect.any(Number),
      blockedMaxFileSizeBytes: 1,
    });
    expect(await store.getEntryById("entry-too-large")).toMatchObject({
      entryId: "entry-too-large",
      path: "Folder/too-large.md",
      hash,
    });
    await store.close();
  });

  it.each([
    ["file_too_large"],
    [""],
  ])(
    "blocks upserts when blob upload returns a non-quota 413 (%s)",
    async (errorCode) => {
      const store = createTestSyncStore();
      const bytes = encodeUtf8("server rejected body");
      const hash = await hashBytes(bytes);
      await store.upsertEntry({
        entryId: "entry-upload-413",
        path: "Folder/upload-413.md",
        revision: 0,
        blobId: "blob-upload-413",
        hash,
        deleted: false,
        updatedAt: 1,
        localMtime: null,
        localSize: bytes.byteLength,
      });
      await store.markEntryDirty({
        mutationId: "mutation-upload-413",
        entryId: "entry-upload-413",
        op: "upsert",
        baseRevision: 0,
        blobId: "blob-upload-413",
        hash,
        encryptedMetadata: await encryptMutationMetadata({
          entryId: "entry-upload-413",
          baseRevision: 0,
          op: "upsert",
          blobId: "blob-upload-413",
          path: "Folder/upload-413.md",
          hash,
        }),
        createdAt: 1,
      });

      const session = createPushSession(async () => {
        throw new Error("413-blocked mutation should not be committed");
      });
      session.maxFileSizeBytes = 0;
      let uploadAttempts = 0;
      const onFileSizeBlockedFilesChange = vi.fn();
      const service = new SyncPushService({
        getApiBaseUrl: () => "http://127.0.0.1:8787",
        getSyncToken: async () => createToken(),
        getSyncStore: () => store,
        getRemoteVaultKey: () => TEST_VAULT_KEY,
        fileReader: {
          async readBytes(path) {
            if (path === "Folder/upload-413.md") {
              return bytes;
            }

            throw new Error(`unexpected read for ${path}`);
          },
        },
        blobClient: {
          async uploadBlob() {
            uploadAttempts += 1;
            throw new SyncBlobUploadError(413, errorCode, "payload too large");
          },
        },
        onProgress: ignoreProgress,
        onFileSizeBlockedFilesChange,
      });

      await expect(service.pushPendingMutations(session)).resolves.toMatchObject({
        mutationsPushed: 0,
        mutationsRequeued: 0,
        hasMore: false,
      });
      expect(uploadAttempts).toBe(1);
      expect(onFileSizeBlockedFilesChange).toHaveBeenCalledTimes(1);
      expect(await store.listDirtyEntries()).toEqual([]);
      expect(await store.getDirtyEntryMutation("entry-upload-413")).toMatchObject({
        mutationId: "mutation-upload-413",
        status: "blocked",
        blockedReason: "file_too_large",
        blockedEncryptedSizeBytes: expect.any(Number),
        blockedMaxFileSizeBytes: null,
      });
      await store.close();
    },
  );

  it("unblocks file-size blocked mutations when the server limit increases", async () => {
    const store = createTestSyncStore();
    await store.markEntryDirty({
      mutationId: "mutation-newly-allowed",
      entryId: "entry-newly-allowed",
      op: "upsert",
      status: "blocked",
      blockedReason: "file_too_large",
      blockedEncryptedSizeBytes: 50,
      blockedMaxFileSizeBytes: 10,
      baseRevision: 0,
      blobId: "blob-newly-allowed",
      hash: "hash-newly-allowed",
      encryptedMetadata: "metadata-newly-allowed",
      createdAt: 1,
    });
    await store.markEntryDirty({
      mutationId: "mutation-still-too-large",
      entryId: "entry-still-too-large",
      op: "upsert",
      status: "blocked",
      blockedReason: "file_too_large",
      blockedEncryptedSizeBytes: 150,
      blockedMaxFileSizeBytes: 10,
      baseRevision: 0,
      blobId: "blob-still-too-large",
      hash: "hash-still-too-large",
      encryptedMetadata: "metadata-still-too-large",
      createdAt: 2,
    });
    const service = new SyncPushService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      fileReader: {
        async readBytes(path) {
          throw new Error(`unexpected read for ${path}`);
        },
      },
      blobClient: unusedBlobClient,
      onProgress: ignoreProgress,
    });

    await expect(service.unblockFileSizeBlockedMutations(100)).resolves.toBe(1);

    const pending = await store.listDirtyEntries();
    expect(pending).toEqual([
      expect.objectContaining({
        mutationId: "mutation-newly-allowed",
      }),
    ]);
    expect(pending[0]?.status).toBeUndefined();
    expect(pending[0]?.blockedReason).toBeUndefined();
    expect(await store.getDirtyEntryMutation("entry-still-too-large")).toMatchObject({
      mutationId: "mutation-still-too-large",
      status: "blocked",
      blockedReason: "file_too_large",
      blockedEncryptedSizeBytes: 150,
    });
    await store.close();
  });

  it("unblocks file-size blocked mutations when file size policy is unlimited", async () => {
    const store = createTestSyncStore();
    await store.markEntryDirty({
      mutationId: "mutation-unblocked-unlimited",
      entryId: "entry-unblocked-unlimited",
      op: "upsert",
      status: "blocked",
      blockedReason: "file_too_large",
      blockedEncryptedSizeBytes: null,
      blockedMaxFileSizeBytes: 10,
      baseRevision: 0,
      blobId: "blob-unblocked-unlimited",
      hash: "hash-unblocked-unlimited",
      encryptedMetadata: "metadata-unblocked-unlimited",
      createdAt: 1,
    });
    const service = new SyncPushService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      fileReader: {
        async readBytes(path) {
          throw new Error(`unexpected read for ${path}`);
        },
      },
      blobClient: unusedBlobClient,
      onProgress: ignoreProgress,
    });

    await expect(service.unblockFileSizeBlockedMutations(0)).resolves.toBe(1);

    expect(await store.listDirtyEntries()).toEqual([
      expect.objectContaining({
        mutationId: "mutation-unblocked-unlimited",
      }),
    ]);
    await store.close();
  });

  it("allows upserts when the server reports an unlimited file size policy", async () => {
    const store = createTestSyncStore();
    const bytes = encodeUtf8("body that is larger than the hosted test limit");
    const hash = await hashBytes(bytes);
    await store.applyLocalState({
      entryId: "entry-unlimited-size",
      path: "Folder/unlimited-size.md",
      blobId: "blob-unlimited-size",
      hash,
      deleted: false,
      updatedAt: 1,
      localMtime: 1,
      localSize: bytes.byteLength,
    });
    await store.applyRemoteState({
      entryId: "entry-unlimited-size",
      path: "Folder/unlimited-size.md",
      revision: 0,
      blobId: null,
      hash: null,
      deleted: false,
      updatedAt: 1,
    });
    await store.markEntryDirty({
      mutationId: "mutation-unlimited-size",
      entryId: "entry-unlimited-size",
      op: "upsert",
      baseRevision: 0,
      blobId: "blob-unlimited-size",
      hash,
      encryptedMetadata: await encryptMutationMetadata({
        entryId: "entry-unlimited-size",
        baseRevision: 0,
        op: "upsert",
        blobId: "blob-unlimited-size",
        path: "Folder/unlimited-size.md",
        hash,
      }),
      createdAt: 1,
    });

    const session = createPushSession(async (mutation) => ({
      cursor: 1,
      entryId: mutation.entryId,
      revision: 1,
    }));
    session.maxFileSizeBytes = 0;
    let uploaded = false;
    const service = new SyncPushService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      fileReader: {
        async readBytes(path) {
          if (path === "Folder/unlimited-size.md") {
            return bytes;
          }

          throw new Error(`unexpected read for ${path}`);
        },
      },
      blobClient: {
        async uploadBlob() {
          uploaded = true;
        },
      },
      onProgress: ignoreProgress,
    });

    await expect(service.pushPendingMutations(session)).resolves.toMatchObject({
      cursor: 1,
      mutationsPushed: 1,
      hasMore: false,
    });
    expect(uploaded).toBe(true);
    expect(await store.listDirtyEntries()).toEqual([]);
    expect(await store.getDirtyEntryMutation("entry-unlimited-size")).toBeNull();
    await store.close();
  });

  it("allows upserts that reuse the base blob", async () => {
    const store = createTestSyncStore();
    const bytes = encodeUtf8("body");
    const hash = await hashBytes(bytes);
    await store.applyRemoteState({
      entryId: "entry-rename",
      path: "Folder/old.md",
      revision: 4,
      blobId: "blob-rename",
      hash,
      deleted: false,
      updatedAt: 1,
    });
    await store.applyLocalState({
      entryId: "entry-rename",
      path: "Folder/new.md",
      blobId: "blob-rename",
      hash,
      deleted: false,
      updatedAt: 2,
      localMtime: null,
      localSize: bytes.byteLength,
    });
    await store.markEntryDirty({
      mutationId: "mutation-rename",
      entryId: "entry-rename",
      op: "upsert",
      baseRevision: 4,
      baseBlobId: "blob-rename",
      baseHash: hash,
      blobId: "blob-rename",
      hash,
      encryptedMetadata: await encryptMutationMetadata({
        entryId: "entry-rename",
        baseRevision: 4,
        op: "upsert",
        blobId: "blob-rename",
        path: "Folder/new.md",
        hash,
      }),
      createdAt: 1,
    });

    const committed: CommitMutationPayload[] = [];
    const session = createPushSession(async (mutation) => {
      committed.push(mutation);
      return {
        cursor: 1,
        entryId: mutation.entryId,
        revision: mutation.baseRevision + 1,
      };
    });
    let uploadAttempts = 0;
    const service = new SyncPushService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      fileReader: {
        async readBytes(path) {
          if (path === "Folder/new.md") {
            return bytes;
          }

          throw new Error(`unexpected read for ${path}`);
        },
      },
      blobClient: {
        async uploadBlob() {
          uploadAttempts += 1;
        },
      },
      onProgress: ignoreProgress,
    });

    await expect(service.pushPendingMutations(session)).resolves.toMatchObject({
      cursor: 1,
      mutationsPushed: 1,
      hasMore: false,
    });
    expect(uploadAttempts).toBe(1);
    expect(committed).toHaveLength(1);
    expect(await store.listDirtyEntries()).toEqual([]);
    expect(await store.getRemoteStateById("entry-rename")).toMatchObject({
      path: "Folder/new.md",
      revision: 5,
      blobId: "blob-rename",
      hash,
    });
    await store.close();
  });

  it("stops with pending upserts when the server reports quota exhaustion during upload", async () => {
    const store = createTestSyncStore();
    const bytes = encodeUtf8("body");
    const hash = await hashBytes(bytes);
    await store.upsertEntry({
      entryId: "entry-server-quota",
      path: "Folder/server-quota.md",
      revision: 0,
      blobId: "blob-server-quota",
      hash,
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: bytes.byteLength,
    });
    await store.markEntryDirty({
      mutationId: "mutation-server-quota",
      entryId: "entry-server-quota",
      op: "upsert",
      baseRevision: 0,
      blobId: "blob-server-quota",
      hash,
      encryptedMetadata: await encryptMutationMetadata({
        entryId: "entry-server-quota",
        baseRevision: 0,
        op: "upsert",
        blobId: "blob-server-quota",
        path: "Folder/server-quota.md",
        hash,
      }),
      createdAt: 1,
    });
    await store.upsertEntry({
      entryId: "entry-after-quota",
      path: "Folder/after-quota.md",
      revision: 0,
      blobId: "blob-after-quota",
      hash,
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: bytes.byteLength,
    });
    await store.markEntryDirty({
      mutationId: "mutation-after-quota",
      entryId: "entry-after-quota",
      op: "upsert",
      baseRevision: 0,
      blobId: "blob-after-quota",
      hash,
      encryptedMetadata: await encryptMutationMetadata({
        entryId: "entry-after-quota",
        baseRevision: 0,
        op: "upsert",
        blobId: "blob-after-quota",
        path: "Folder/after-quota.md",
        hash,
      }),
      createdAt: 2,
    });

    const session = createPushSession(async () => {
      throw new Error("quota-exceeded mutation should not be committed");
    });
    const uploadAttempts: string[] = [];
    const service = new SyncPushService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      fileReader: {
        async readBytes(path) {
          if (
            path === "Folder/server-quota.md" ||
            path === "Folder/after-quota.md"
          ) {
            return bytes;
          }

          throw new Error(`unexpected read for ${path}`);
        },
      },
      blobClient: {
        async uploadBlob(_apiBaseUrl, _syncToken, _vaultId, blobId) {
          uploadAttempts.push(blobId);
          throw new SyncBlobUploadError(413, "quota_exceeded", "quota exceeded");
        },
      },
      onProgress: ignoreProgress,
    });

    await expect(service.pushPendingMutations(session)).resolves.toMatchObject({
      mutationsPushed: 0,
      mutationsRequeued: 0,
      hasMore: true,
      stopReason: "storage_quota_exceeded",
    });
    expect(new Set(uploadAttempts)).toEqual(
      new Set(["blob-server-quota", "blob-after-quota"]),
    );
    const pending = await store.listDirtyEntries();
    expect(pending.map((mutation) => mutation.mutationId)).toEqual([
      "mutation-server-quota",
      "mutation-after-quota",
    ]);
    expect(pending.map((mutation) => mutation.status ?? "pending")).toEqual([
      "pending",
      "pending",
    ]);
    expect(pending.map((mutation) => mutation.blockedReason ?? null)).toEqual([
      null,
      null,
    ]);
    await store.close();
  });

  it("stops with a pending upsert when storage quota is exhausted", async () => {
    const store = createTestSyncStore();
    const bytes = encodeUtf8("body");
    const hash = await hashBytes(bytes);
    await store.upsertEntry({
      entryId: "entry-known-quota",
      path: "Folder/known-quota.md",
      revision: 0,
      blobId: "blob-known-quota",
      hash,
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: bytes.byteLength,
    });
    await store.markEntryDirty({
      mutationId: "mutation-known-quota",
      entryId: "entry-known-quota",
      op: "upsert",
      baseRevision: 0,
      blobId: "blob-known-quota",
      hash,
      encryptedMetadata: await encryptMutationMetadata({
        entryId: "entry-known-quota",
        baseRevision: 0,
        op: "upsert",
        blobId: "blob-known-quota",
        path: "Folder/known-quota.md",
        hash,
      }),
      createdAt: 1,
    });

    const session = createPushSession(async () => {
      throw new Error("quota-exceeded mutation should not be committed");
    });
    session.storageUsedBytes = 50_000_000;
    session.storageLimitBytes = 50_000_000;
    let uploadAttempts = 0;
    const service = new SyncPushService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      fileReader: {
        async readBytes(path) {
          if (path === "Folder/known-quota.md") {
            return bytes;
          }

          throw new Error(`unexpected read for ${path}`);
        },
      },
      blobClient: {
        async uploadBlob() {
          uploadAttempts += 1;
          throw new SyncBlobUploadError(413, "quota_exceeded", "quota exceeded");
        },
      },
      onProgress: ignoreProgress,
    });

    await expect(service.pushPendingMutations(session)).resolves.toMatchObject({
      mutationsPushed: 0,
      mutationsRequeued: 0,
      hasMore: true,
      stopReason: "storage_quota_exceeded",
    });
    expect(uploadAttempts).toBe(1);
    const pending = await store.listDirtyEntries();
    expect(pending.map((mutation) => mutation.mutationId)).toEqual([
      "mutation-known-quota",
    ]);
    const quotaMutation = await store.getDirtyEntryMutation("entry-known-quota");
    expect(quotaMutation).toMatchObject({
      mutationId: "mutation-known-quota",
    });
    expect(quotaMutation?.status ?? "pending").toBe("pending");
    expect(quotaMutation?.blockedReason ?? null).toBeNull();
    await store.close();
  });

  it("stops with a pending upsert when the server rejects near-quota uploads", async () => {
    const store = createTestSyncStore();
    const bytes = new Uint8Array(600_000).fill(1);
    const hash = await hashBytes(bytes);
    await store.upsertEntry({
      entryId: "entry-near-quota",
      path: "Folder/near-quota.md",
      revision: 0,
      blobId: "blob-near-quota",
      hash,
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: bytes.byteLength,
    });
    await store.markEntryDirty({
      mutationId: "mutation-near-quota",
      entryId: "entry-near-quota",
      op: "upsert",
      baseRevision: 0,
      blobId: "blob-near-quota",
      hash,
      encryptedMetadata: await encryptMutationMetadata({
        entryId: "entry-near-quota",
        baseRevision: 0,
        op: "upsert",
        blobId: "blob-near-quota",
        path: "Folder/near-quota.md",
        hash,
      }),
      createdAt: 1,
    });

    const session = createPushSession(async () => {
      throw new Error("quota-exceeded mutation should not be committed");
    });
    session.storageUsedBytes = 49_500_000;
    session.storageLimitBytes = 50_000_000;
    let uploadAttempts = 0;
    const service = new SyncPushService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      fileReader: {
        async readBytes(path) {
          if (path === "Folder/near-quota.md") {
            return bytes;
          }

          throw new Error(`unexpected read for ${path}`);
        },
      },
      blobClient: {
        async uploadBlob() {
          uploadAttempts += 1;
          throw new SyncBlobUploadError(413, "quota_exceeded", "quota exceeded");
        },
      },
      onProgress: ignoreProgress,
    });

    await expect(service.pushPendingMutations(session)).resolves.toMatchObject({
      mutationsPushed: 0,
      mutationsRequeued: 0,
      hasMore: true,
      stopReason: "storage_quota_exceeded",
    });
    expect(uploadAttempts).toBe(1);
    const pending = await store.listDirtyEntries();
    expect(pending.map((mutation) => mutation.mutationId)).toEqual([
      "mutation-near-quota",
    ]);
    const quotaMutation = await store.getDirtyEntryMutation("entry-near-quota");
    expect(quotaMutation).toMatchObject({
      mutationId: "mutation-near-quota",
    });
    expect(quotaMutation?.status ?? "pending").toBe("pending");
    expect(quotaMutation?.blockedReason ?? null).toBeNull();
    await store.close();
  });

});
