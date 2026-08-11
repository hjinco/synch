
import { decryptSyncMetadata, encryptSyncMetadata } from "../../../core/crypto";
import type { SyncStore } from "../../../store/store";

export const TEST_VAULT_KEY = new Uint8Array(
  Array.from({ length: 32 }, (_, index) => index + 1),
);

export function decryptPendingMetadata(
  pending:
    | {
        entryId: string;
        baseRevision: number;
        op: "upsert" | "delete";
        blobId: string | null;
        encryptedMetadata: string;
      }
    | null
    | undefined,
) {
  if (!pending) {
    throw new Error("missing pending mutation");
  }

  return decryptSyncMetadata(TEST_VAULT_KEY, pending.encryptedMetadata, {
    entryId: pending.entryId,
    revision: pending.baseRevision + 1,
    op: pending.op,
    blobId: pending.blobId,
  });
}

export async function encryptTestMetadata(input: {
  entryId: string;
  revision: number;
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
      revision: input.revision,
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
