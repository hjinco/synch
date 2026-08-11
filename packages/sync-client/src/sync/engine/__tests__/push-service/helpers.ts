
import type { SyncTokenResponse } from "../../../remote/client";
import { encryptSyncMetadata } from "../../../core/crypto";
import type { SyncStore } from "../../../store/store";
import {
  SyncRealtimeError,
  type SyncRealtimeSession,
  type CommitMutationsResult,
  type CommitMutationPayload,
} from "../../../remote/realtime-client";

export const TEST_VAULT_KEY = new Uint8Array(
  Array.from({ length: 32 }, (_, index) => index + 1),
);

export function createToken(): SyncTokenResponse {
  return {
    token: "sync-token",
    expiresAt: 1_000,
    vaultId: "vault-1",
    localVaultId: "local-vault-1",
    syncFormatVersion: 1,
  };
}

export function createPushSession(
  commitMutation: SyncRealtimeSession["commitMutation"],
  commitMutations?: SyncRealtimeSession["commitMutations"],
): SyncRealtimeSession {
  return {
    serverCursor: 0,
    storageUsedBytes: 0,
    storageLimitBytes: 100_000_000,
    maxFileSizeBytes: 3_000_000,
    watchStorageStatus() {},
    unwatchStorageStatus() {},
    async listEntryStates() {
      throw new Error("push tests should not list entry states");
    },
    async listEntryVersions() {
      throw new Error("push tests should not list entry versions");
    },
    async listDeletedEntries() {
      throw new Error("push tests should not list deleted entries");
    },
    async restoreEntryVersion() {
      throw new Error("push tests should not restore entry versions");
	    },
    async restoreEntryVersions() {
      throw new Error("push tests should not restore entry versions");
    },
    async purgeDeletedEntries() {
      throw new Error("push tests should not purge deleted entries");
    },
	    async detachLocalVault() {},
	    commitMutation,
    async commitMutations(mutations): Promise<CommitMutationsResult> {
      if (commitMutations) {
        return await commitMutations(mutations);
      }

      const results = [];
      let cursor = 0;
      for (const mutation of mutations) {
        try {
          const accepted = await commitMutation(mutation);
          cursor = Math.max(cursor, accepted.cursor);
          results.push({
            status: "accepted" as const,
            mutationId: mutation.mutationId,
            ...accepted,
          });
        } catch (error) {
          if (!(error instanceof SyncRealtimeError)) {
            throw error;
          }
          results.push({
            status: "rejected" as const,
            mutationId: mutation.mutationId,
            entryId: mutation.entryId,
            code: error.code,
            message: error.message,
            expectedBaseRevision: error.details.expectedBaseRevision,
            receivedBaseRevision: error.details.receivedBaseRevision,
          });
        }
      }
      return { cursor, results };
    },
    close() {},
  };
}

export async function ignoreProgress(): Promise<void> {}

export const unusedBlobClient = {
  async uploadBlob(): Promise<void> {
    throw new Error("this test should not upload blobs");
  },
};

export async function encryptMutationMetadata(input: {
  entryId: string;
  baseRevision: number;
  op: "upsert" | "delete";
  blobId: string | null;
  path: string;
  hash?: string;
}) {
  const hash = input.op === "delete" ? null : requireHash(input.hash);
  return await encryptSyncMetadata(
    TEST_VAULT_KEY,
    {
      path: input.path,
      hash,
    },
    {
      entryId: input.entryId,
      revision: input.baseRevision + 1,
      op: input.op,
      blobId: input.blobId,
    },
  );
}

export async function putTestBaseBlob(
  store: SyncStore,
  input: {
    blobId: string;
    hash: string;
    bytes?: Uint8Array;
  },
): Promise<void> {
  await store.putBlob({
    blobId: input.blobId,
    hash: input.hash,
    encryptedBytes: input.bytes ?? new Uint8Array(),
    role: "base",
    cachedAt: 1,
  });
}

function requireHash(hash: string | undefined): string {
  if (!hash) {
    throw new Error("test metadata hash is required for upserts");
  }

  return hash;
}

export function metadataContextFromPayload(payload: CommitMutationPayload | undefined) {
  if (!payload) {
    throw new Error("missing committed payload");
  }

  return {
    entryId: payload.entryId,
    revision: payload.baseRevision + 1,
    op: payload.op,
    blobId: payload.blobId,
  };
}
