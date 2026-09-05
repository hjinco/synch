import { describe, expect, it, vi } from "vitest";

import { encodeUtf8, hashBytes } from "../../core/content";
import { createTestSyncStore } from "../../../test-support/in-memory-sync-store";
import type { PendingMutationRow } from "../../store/store";
import { PushMutationPreparer } from "../push-mutation-preparer";
import { PushBlobRetryCache } from "../push-blob-retry-cache";
import { createSyncCryptoContext, encryptedSyncBlobSize } from "../../core/crypto";
import { SyncContentRuntime } from "../../core/content-runtime";
import {
  createToken,
  encryptMutationMetadata,
  TEST_VAULT_KEY,
} from "./push-service/helpers";

describe("PushMutationPreparer encrypted payload retention", () => {
  it.each([
    ["Folder/image.png", false],
    ["Folder/note.md", true],
  ])(
    "retains encrypted bytes only for auto-merge text files (%s)",
    async (path, shouldRetainEncryptedBytes) => {
      const store = createTestSyncStore();
      const bytes = encodeUtf8("file body");
      const hash = await hashBytes(bytes);
      const blobId = `blob-${path}`;
      const mutation: PendingMutationRow = {
        mutationId: `mutation-${path}`,
        entryId: `entry-${path}`,
        op: "upsert",
        baseRevision: 0,
        blobId,
        hash,
        encryptedMetadata: await encryptMutationMetadata({
          entryId: `entry-${path}`,
          baseRevision: 0,
          op: "upsert",
          blobId,
          path,
          hash,
        }),
        createdAt: 1,
      };
      let uploadedBytes: Uint8Array | null = null;
      const preparer = new PushMutationPreparer({
        getApiBaseUrl: () => "http://127.0.0.1:8787",
        getRemoteVaultKey: () => TEST_VAULT_KEY,
        fileReader: {
          async readBytes(readPath) {
            expect(readPath).toBe(path);
            return bytes;
          },
        },
        blobClient: {
          async uploadBlob(
            _apiBaseUrl,
            _syncToken,
            _vaultId,
            _blobId,
            encryptedBytes,
          ) {
            uploadedBytes = encryptedBytes;
          },
        },
        remotelyStagedBlobIds: new Set<string>(),
      });

      const prepared = await preparer.prepareMutationForCommit(
        store,
        createToken(),
        mutation,
        0,
      );

      expect(prepared).not.toBeNull();
      expect(prepared).not.toHaveProperty("skipped");
      if (!prepared || "skipped" in prepared) {
        throw new Error("expected a prepared mutation");
      }
      expect(uploadedBytes).toBeInstanceOf(Uint8Array);
      expect(prepared.encryptedBytes).toBe(
        shouldRetainEncryptedBytes ? uploadedBytes : null,
      );

      await store.close();
    },
  );
});

describe("PushMutationPreparer retries", () => {
  it("bounds cached ciphertext and isolates vaults and metadata", async () => {
    const fixture = await createRetryFixture("note.md");
    try {
      const bytes = await fixture.crypto.encryptBlob(encodeUtf8("original"), { blobId: "blob" });
      const cache = new PushBlobRetryCache(bytes.byteLength);
      const mutation = fixture.mutation;
      cache.put(mutation, "vault", bytes);
      expect(cache.get(mutation, "vault")).toBe(bytes);
      expect(cache.get(mutation, "other-vault")).toBeNull();
      expect(cache.get({ ...mutation, encryptedMetadata: "different" }, "vault")).toBeNull();
      const other = { ...mutation, blobId: "other-blob" };
      cache.put(other, "vault", bytes);
      expect(cache.get(mutation, "vault")).toBeNull();
      expect(cache.get(other, "vault")).toBe(bytes);
      cache.delete(other.blobId);
      expect(cache.get(other, "vault")).toBeNull();
      cache.put(mutation, "vault", new Uint8Array(bytes.byteLength + 1));
      expect(cache.get(mutation, "vault")).toBeNull();
      cache.put(mutation, "vault", bytes);
      expect(cache.get(mutation, "vault")).toBe(bytes);
    } finally {
      await fixture.dispose();
    }
  });

  it.each(["note.md", "image.png"])(
    "reuses staged %s without encryption but still detects changed contents",
    async (path) => {
      const fixture = await createRetryFixture(path);
      try {
        const first = await fixture.prepare();
        const retry = await fixture.prepare();
        expect(fixture.encrypt).toHaveBeenCalledTimes(1);
        expect(fixture.upload).toHaveBeenCalledTimes(1);
        if (!first || "skipped" in first || !retry || "skipped" in retry) {
          throw new Error("expected prepared mutations");
        }
        if (path.endsWith(".md")) {
          expect(retry.encryptedBytes).toBe(first.encryptedBytes);
          expect(await fixture.crypto.decryptBlob(retry.encryptedBytes!, {
            blobId: fixture.mutation.blobId!,
          })).toEqual(encodeUtf8("original"));
        } else {
          expect(retry.encryptedBytes).toBeNull();
        }
        fixture.changeContents(encodeUtf8("edited while commit was pending"));
        expect(await fixture.prepare()).toBeNull();
        expect(fixture.upload).toHaveBeenCalledTimes(1);
        const pending = await fixture.store.getDirtyEntryMutation(fixture.mutation.entryId);
        expect(pending?.hash).toBe(await hashBytes(encodeUtf8("edited while commit was pending")));
        expect(pending?.mutationId).not.toBe(fixture.mutation.mutationId);
      } finally {
        await fixture.dispose();
      }
    },
  );

  it("regenerates a Markdown merge base when the retry cache cannot retain it", async () => {
    const fixture = await createRetryFixture("note.md", new PushBlobRetryCache(0));
    try {
      await fixture.prepare();
      const retry = await fixture.prepare();
      expect(fixture.upload).toHaveBeenCalledTimes(1);
      expect(fixture.encrypt).toHaveBeenCalledTimes(2);
      if (!retry || "skipped" in retry || !retry.encryptedBytes) {
        throw new Error("expected a merge base");
      }
      expect(await fixture.crypto.decryptBlob(retry.encryptedBytes, {
        blobId: fixture.mutation.blobId!,
      })).toEqual(encodeUtf8("original"));
    } finally {
      await fixture.dispose();
    }
  });

  it("enforces the encrypted size boundary before encryption, including staged retries", async () => {
    const fixture = await createRetryFixture("image.png");
    try {
      const actual = await fixture.crypto.encryptBlob(encodeUtf8("original"), {
        blobId: fixture.mutation.blobId!,
      });
      expect(encryptedSyncBlobSize(encodeUtf8("original").byteLength)).toBe(actual.byteLength);
      fixture.encrypt.mockClear();
      expect(await fixture.prepare(actual.byteLength - 1)).toMatchObject({
        skipped: true, reason: "file_too_large",
      });
      expect(fixture.encrypt).not.toHaveBeenCalled();
      expect(fixture.upload).not.toHaveBeenCalled();
      expect(await fixture.prepare(actual.byteLength)).not.toHaveProperty("skipped");
      expect(await fixture.prepare(actual.byteLength - 1)).toMatchObject({
        skipped: true, reason: "file_too_large",
      });
      expect(fixture.upload).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.dispose();
    }
  });
});

async function createRetryFixture(path: string, blobRetryCache = new PushBlobRetryCache()) {
  const store = createTestSyncStore();
  const crypto = createSyncCryptoContext(TEST_VAULT_KEY);
  const contentRuntime = new SyncContentRuntime();
  let bytes = encodeUtf8("original");
  const hash = await hashBytes(bytes);
  const mutation: PendingMutationRow = {
    mutationId: "mutation", entryId: "entry", op: "upsert", baseRevision: 0,
    blobId: "blob", hash, createdAt: 1,
    encryptedMetadata: await encryptMutationMetadata({
      entryId: "entry", baseRevision: 0, op: "upsert", blobId: "blob", path, hash,
    }),
  };
  await store.markEntryDirty(mutation);
  const encrypt = vi.spyOn(crypto, "encryptBlob");
  const upload = vi.fn(async () => {});
  const preparer = new PushMutationPreparer({
    getApiBaseUrl: () => "http://127.0.0.1:8787",
    getRemoteVaultKey: () => TEST_VAULT_KEY,
    getSyncCryptoContext: () => crypto,
    contentRuntime,
    fileReader: { readBytes: async () => bytes },
    blobClient: { uploadBlob: upload },
    remotelyStagedBlobIds: new Set(), blobRetryCache,
  });
  return {
    store, crypto, mutation, encrypt, upload,
    changeContents: (updated: Uint8Array) => { bytes = updated; },
    prepare: (maxBytes = 0) => preparer.prepareMutationForCommit(store, createToken(), mutation, maxBytes),
    dispose: async () => {
      crypto.dispose();
      await contentRuntime.dispose();
      await store.close();
    },
  };
}
