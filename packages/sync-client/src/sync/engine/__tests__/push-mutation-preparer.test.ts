import { describe, expect, it } from "vitest";

import { encodeUtf8, hashBytes } from "../../core/content";
import { createTestSyncStore } from "../../../test-support/in-memory-sync-store";
import type { PendingMutationRow } from "../../store/store";
import { PushMutationPreparer } from "../push-mutation-preparer";
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
