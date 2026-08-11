
import type { SyncTokenResponse } from "../../../remote/client";
import type { ListEntryStatesResponse } from "../../../remote/changes";
import { encryptSyncBlob, encryptSyncMetadata } from "../../../core/crypto";
import { hashBytes } from "../../../core/content";
import type { SyncEventGateLike } from "../../event-gate";
import type { SyncPullClient } from "../../../remote/pull-client";
import type { SyncRealtimeSession } from "../../../remote/realtime-client";
import type { SyncStore } from "../../../store/store";

export const TEST_VAULT_KEY = new Uint8Array(
  Array.from({ length: 32 }, (_, index) => index + 1),
);

type TestChangePage = {
  cursor: number;
  hasMore: boolean;
  commits: ReturnType<typeof createCommit>[];
};

export type PullConflictSummary = {
  entryId: string;
  reason: "local_pending_mutation" | "remote_path_collision";
  originalPath: string;
  conflictPath: string | null;
};

export function createToken(): SyncTokenResponse {
  return {
    token: "sync-token",
    expiresAt: 1_000,
    vaultId: "vault-1",
    localVaultId: "local-vault-1",
    syncFormatVersion: 1,
  };
}

export function createCommit(
  overrides: Partial<{
    cursor: number;
    entryId: string;
    op: "upsert" | "delete";
    revision: number;
    baseRevision: number;
    blobId: string | null;
    encryptedMetadata: string;
    committedAt: number;
  }> = {},
) {
  return {
    cursor: overrides.cursor ?? 1,
    entryId: overrides.entryId ?? "entry-1",
    op: overrides.op ?? "upsert",
    revision: overrides.revision ?? 1,
    baseRevision: overrides.baseRevision ?? 0,
    blobId: overrides.blobId ?? null,
    encryptedMetadata:
      overrides.encryptedMetadata ??
      JSON.stringify({
        path: "Folder/file.md",
      }),
    committedAt: overrides.committedAt ?? (overrides.cursor ?? 1),
    committedByUserId: "user-1",
    committedByLocalVaultId: "local-vault-1",
  };
}

export async function encryptRemoteMetadata(input: {
  entryId: string;
  revision: number;
  deleted?: boolean;
  blobId: string | null;
  path: string;
  hash?: string;
}) {
  const hash = input.deleted ? null : requireHash(input.hash);
  return await encryptSyncMetadata(
    TEST_VAULT_KEY,
    {
      path: input.path,
      hash,
    },
    {
      entryId: input.entryId,
      revision: input.revision,
      op: input.deleted ? "delete" : "upsert",
      blobId: input.blobId,
    },
  );
}

export async function encryptPendingMetadata(input: {
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

export async function encryptTestBlob(blobId: string, bytes: Uint8Array) {
  return await encryptSyncBlob(TEST_VAULT_KEY, bytes, { blobId }, {
    syncFormatVersion: 1,
  });
}

export async function hashText(value: string): Promise<string> {
  return await hashBytes(new TextEncoder().encode(value));
}

export async function ignoreProgress(): Promise<void> {}

export async function arrangePendingUpsertWithCachedBase(
  store: SyncStore,
  input: {
    entryId: string;
    path: string;
    baseRevision: number;
    baseBlobId: string;
    baseHash: string;
    baseBytes: Uint8Array;
    localBlobId: string;
    localHash: string;
    createdAt: number;
    mutationId?: string;
  },
): Promise<void> {
  await store.upsertEntry({
    entryId: input.entryId,
    path: input.path,
    revision: input.baseRevision,
    blobId: input.baseBlobId,
    hash: input.baseHash,
    deleted: false,
    updatedAt: 1,
    localMtime: null,
    localSize: null,
  });
  await store.putBlob({
    blobId: input.baseBlobId,
    hash: input.baseHash,
    encryptedBytes: await encryptTestBlob(input.baseBlobId, input.baseBytes),
    role: "base",
    refEntryId: input.entryId,
    cachedAt: 1,
  });
  await store.applyLocalState({
    entryId: input.entryId,
    path: input.path,
    blobId: input.localBlobId,
    hash: input.localHash,
    deleted: false,
    updatedAt: 2,
    localMtime: null,
    localSize: null,
  });
  await store.markEntryDirty(
    {
      mutationId: input.mutationId ?? `mutation-${input.entryId}`,
      entryId: input.entryId,
      op: "upsert",
      baseRevision: input.baseRevision,
      baseBlobId: input.baseBlobId,
      baseHash: input.baseHash,
      blobId: input.localBlobId,
      hash: input.localHash,
      encryptedMetadata: await encryptPendingMetadata({
        entryId: input.entryId,
        baseRevision: input.baseRevision,
        op: "upsert",
        blobId: input.localBlobId,
        path: input.path,
        hash: input.localHash,
      }),
      createdAt: input.createdAt,
    },
    { requireBaseBlob: true },
  );
}

function requireHash(hash: string | undefined): string {
  if (!hash) {
    throw new Error("test metadata hash is required for upserts");
  }

  return hash;
}

export function createPullClient(input: {
  blobs?: Record<string, string | Uint8Array>;
}): SyncPullClient {
  return {
    async downloadBlob(
      _apiBaseUrl: string,
      _syncToken: string,
      _vaultId: string,
      blobId: string,
    ): Promise<Uint8Array> {
      const value = input.blobs?.[blobId];
      if (value === undefined) {
        throw new Error(`missing blob fixture for ${blobId}`);
      }

      return typeof value === "string" ? new TextEncoder().encode(value) : value;
    },
  } as SyncPullClient;
}

export function createRealtimeSession(input: {
  pages: Array<TestChangePage | Error>;
}): SyncRealtimeSession {
  let pageIndex = 0;

  return {
    serverCursor: 0,
    storageUsedBytes: 0,
    storageLimitBytes: 100_000_000,
    maxFileSizeBytes: 3_000_000,
    watchStorageStatus() {},
    unwatchStorageStatus() {},
    async listEntryStates(): Promise<ListEntryStatesResponse> {
      const page = input.pages[pageIndex];
      pageIndex += 1;
      if (!page) {
        throw new Error("unexpected extra listEntryStates call");
      }
      if (page instanceof Error) {
        throw page;
      }

      const latestByEntry = new Map<string, (typeof page.commits)[number]>();
      for (const commit of page.commits) {
        latestByEntry.set(commit.entryId, commit);
      }
      const entries = [...latestByEntry.values()];
      const lastEntry = entries[entries.length - 1];

      return {
        targetCursor: page.cursor,
        totalEntries: input.pages.reduce(
          (total, changePage) =>
            changePage instanceof Error ? total : total + changePage.commits.length,
          0,
        ),
        hasMore: page.hasMore,
        nextAfter: page.hasMore
          ? lastEntry
            ? {
                updatedSeq: lastEntry.cursor,
                entryId: lastEntry.entryId,
              }
            : null
          : null,
        entries: entries.map((commit) => ({
          entryId: commit.entryId,
          revision: commit.revision,
          blobId: commit.blobId,
          encryptedMetadata: commit.encryptedMetadata,
          deleted: commit.op === "delete",
          updatedSeq: commit.cursor,
          updatedAt: commit.committedAt,
        })),
      };
    },
    async listEntryVersions() {
      throw new Error("pull tests should not list entry versions");
    },
    async listDeletedEntries() {
      throw new Error("pull tests should not list deleted entries");
    },
    async restoreEntryVersion() {
      throw new Error("pull tests should not restore entry versions");
    },
    async restoreEntryVersions() {
      throw new Error("pull tests should not restore entry versions");
    },
    async purgeDeletedEntries() {
      throw new Error("pull tests should not purge deleted entries");
    },
	    async detachLocalVault() {},
	    async commitMutation() {
      throw new Error("pull tests should not commit mutations");
    },
    async commitMutations() {
      throw new Error("pull tests should not commit mutations");
    },
    close() {},
  };
}

export function createEventGate(calls: string[][]): SyncEventGateLike {
  return {
    isSuppressed(): boolean {
      return false;
    },
    async suppressPaths(paths, action) {
      calls.push(paths.filter((path): path is string => typeof path === "string"));
      return await action();
    },
  };
}

export function createVaultAdapter(initialFiles: Record<string, string | Uint8Array> = {}) {
  const files = new Map<string, Uint8Array>(
    Object.entries(initialFiles).map(([path, value]) => [
      path,
      typeof value === "string" ? new TextEncoder().encode(value) : value,
    ]),
  );
  const directories = new Set<string>();
  const renames: Array<{ oldPath: string; newPath: string }> = [];
  const removes: string[] = [];
  const writes: string[] = [];

  return {
    files,
    renames,
    removes,
    writes,
    text(path: string): string | null {
      const bytes = files.get(path);
      return bytes ? new TextDecoder().decode(bytes) : null;
    },
    bytes(path: string): Uint8Array | null {
      return files.get(path) ?? null;
    },
    async exists(path: string): Promise<boolean> {
      return files.has(path) || directories.has(path);
    },
    async mkdir(path: string): Promise<void> {
      directories.add(path);
    },
    async readBytes(path: string): Promise<Uint8Array> {
      const bytes = files.get(path);
      if (!bytes) {
        throw new Error(`missing file fixture for ${path}`);
      }

      return bytes;
    },
    async writeText(path: string, content: string): Promise<void> {
      writes.push(path);
      files.set(path, new TextEncoder().encode(content));
    },
    async writeBinary(path: string, content: Uint8Array): Promise<void> {
      writes.push(path);
      files.set(path, content);
    },
    async rename(oldPath: string, newPath: string): Promise<void> {
      const bytes = files.get(oldPath);
      if (!bytes) {
        throw new Error(`missing file fixture for ${oldPath}`);
      }

      renames.push({ oldPath, newPath });
      files.delete(oldPath);
      files.set(newPath, bytes);
    },
    async remove(path: string): Promise<void> {
      removes.push(path);
      files.delete(path);
      directories.delete(path);
    },
  };
}
