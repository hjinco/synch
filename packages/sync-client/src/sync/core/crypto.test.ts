import { describe, expect, it } from "vitest";

import {
  createSyncCryptoContext,
  decryptSyncBlob,
  decryptSyncMetadata,
  encryptSyncBlob,
  encryptSyncMetadata,
} from "./crypto";

const TEST_VAULT_KEY = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1));
const WRONG_VAULT_KEY = new Uint8Array(Array.from({ length: 32 }, (_, index) => 255 - index));
const TEST_METADATA_CONTEXT = {
  entryId: "entry-1",
  revision: 1,
  op: "upsert" as const,
  blobId: "blob-1",
};
const TEST_BLOB_CONTEXT = {
  blobId: "blob-1",
};
const TEST_BLOB_OPTIONS = {
  syncFormatVersion: 1,
};
const TEST_BLOB_V2_OPTIONS = {
  syncFormatVersion: 2,
};

describe("sync crypto", () => {
  it("round-trips encrypted metadata", async () => {
    const encrypted = await encryptSyncMetadata(TEST_VAULT_KEY, {
      path: "Folder/note.md",
      hash: "hash-1",
    }, TEST_METADATA_CONTEXT);

    expect(encrypted).not.toContain("Folder/note.md");
    await expect(decryptSyncMetadata(TEST_VAULT_KEY, encrypted, TEST_METADATA_CONTEXT)).resolves.toEqual({
      path: "Folder/note.md",
      hash: "hash-1",
    });
  });

  it("round-trips encrypted blobs", async () => {
    const plaintext = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const encrypted = await encryptSyncBlob(
      TEST_VAULT_KEY,
      plaintext,
      TEST_BLOB_CONTEXT,
      TEST_BLOB_OPTIONS,
    );

    expect(encrypted).not.toEqual(plaintext);
    await expect(
      decryptSyncBlob(TEST_VAULT_KEY, encrypted, TEST_BLOB_CONTEXT, TEST_BLOB_OPTIONS),
    ).resolves.toEqual(plaintext);
  });

  it("round-trips encrypted v2 binary blobs", async () => {
    const plaintext = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const encrypted = await encryptSyncBlob(
      TEST_VAULT_KEY,
      plaintext,
      TEST_BLOB_CONTEXT,
      TEST_BLOB_V2_OPTIONS,
    );

    expect(new TextDecoder().decode(encrypted.slice(0, 4))).toBe("SYNB");
    expect(encrypted[4]).toBe(2);
    expect(() => JSON.parse(new TextDecoder().decode(encrypted))).toThrow();
    await expect(
      decryptSyncBlob(TEST_VAULT_KEY, encrypted, TEST_BLOB_CONTEXT, TEST_BLOB_V2_OPTIONS),
    ).resolves.toEqual(plaintext);
  });

  it("reuses a vault-scoped crypto context across payload types", async () => {
    const context = createSyncCryptoContext(TEST_VAULT_KEY);
    const metadata = await context.encryptMetadata({
      path: "Folder/context.md",
      hash: "hash-context",
    }, TEST_METADATA_CONTEXT);
    const blob = await context.encryptBlob(
      new Uint8Array([7, 8, 9]),
      TEST_BLOB_CONTEXT,
      TEST_BLOB_V2_OPTIONS,
    );

    await expect(context.decryptMetadata(metadata, TEST_METADATA_CONTEXT)).resolves.toEqual({
      path: "Folder/context.md",
      hash: "hash-context",
    });
    await expect(
      context.decryptBlob(blob, TEST_BLOB_CONTEXT, TEST_BLOB_V2_OPTIONS),
    ).resolves.toEqual(new Uint8Array([7, 8, 9]));
  });

  it("rejects use after disposing a vault-scoped crypto context", async () => {
    const context = createSyncCryptoContext(TEST_VAULT_KEY);
    await context.encryptBlob(
      new Uint8Array([1]),
      TEST_BLOB_CONTEXT,
      TEST_BLOB_OPTIONS,
    );

    context.dispose();

    await expect(
      context.encryptBlob(new Uint8Array([2]), TEST_BLOB_CONTEXT, TEST_BLOB_OPTIONS),
    ).rejects.toThrow("Sync crypto context has been disposed.");
  });

  it("rejects unsupported sync blob format versions", async () => {
    await expect(
      encryptSyncBlob(
        TEST_VAULT_KEY,
        new Uint8Array([1, 2, 3]),
        TEST_BLOB_CONTEXT,
        { syncFormatVersion: 3 },
      ),
    ).rejects.toThrow("Unsupported sync blob format version: 3.");
  });

  it("rejects the wrong vault key", async () => {
    const encrypted = await encryptSyncMetadata(TEST_VAULT_KEY, {
      path: "Folder/secret.md",
      hash: "hash-1",
    }, TEST_METADATA_CONTEXT);

    await expect(
      decryptSyncMetadata(WRONG_VAULT_KEY, encrypted, TEST_METADATA_CONTEXT),
    ).rejects.toThrow();
  });

  it("rejects metadata attached to the wrong entry context", async () => {
    const encrypted = await encryptSyncMetadata(
      TEST_VAULT_KEY,
      {
        path: "Folder/secret.md",
        hash: "hash-1",
      },
      TEST_METADATA_CONTEXT,
    );

    await expect(
      decryptSyncMetadata(TEST_VAULT_KEY, encrypted, {
        ...TEST_METADATA_CONTEXT,
        entryId: "entry-2",
      }),
    ).rejects.toThrow();
  });

  it("rejects blobs served under the wrong blob id", async () => {
    const encrypted = await encryptSyncBlob(
      TEST_VAULT_KEY,
      new Uint8Array([1, 2, 3]),
      TEST_BLOB_CONTEXT,
      TEST_BLOB_OPTIONS,
    );

    await expect(
      decryptSyncBlob(
        TEST_VAULT_KEY,
        encrypted,
        { blobId: "blob-2" },
        TEST_BLOB_OPTIONS,
      ),
    ).rejects.toThrow();
  });

  it("rejects v2 blobs served under the wrong blob id", async () => {
    const encrypted = await encryptSyncBlob(
      TEST_VAULT_KEY,
      new Uint8Array([1, 2, 3]),
      TEST_BLOB_CONTEXT,
      TEST_BLOB_V2_OPTIONS,
    );

    await expect(
      decryptSyncBlob(
        TEST_VAULT_KEY,
        encrypted,
        { blobId: "blob-2" },
        TEST_BLOB_V2_OPTIONS,
      ),
    ).rejects.toThrow();
  });
});
