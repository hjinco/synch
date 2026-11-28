import { createTestContentRuntime } from "../../../../test-support/content-runtime";
import { describe, expect, it } from "vitest";

import { hashBytes } from "../../../core/content";
import { SyncPullService } from "../../pull-service";
import { createTestSyncStore } from "../../../../test-support/in-memory-sync-store";
import {
  arrangePendingUpsertWithCachedBase,
  createCommit,
  createBlobClient,
  createRealtimeSession,
  createToken,
  createVaultAdapter,
  encryptRemoteMetadata,
  encryptTestBlob,
  hashText,
  ignoreProgress,
  TEST_VAULT_KEY,
  type PullConflictSummary,
} from "./helpers";

const conflictTimestamp = () => new Date(2026, 3, 22, 10, 11, 12).getTime();

describe("SyncPullService pending upsert rebase conflict resolution", () => {
  const independentEdits = {
    baseBody: "Title\n\noriginal line\n",
    localBody: "Title\n\nlocal line\n",
    remoteBody: "Remote title\n\noriginal line\n",
    mergedBody: "Remote title\n\nlocal line\n",
  };
  it.each(["identical", "included by remote"] as const)("preserves a later save when the pending edit is %s", async (initial) => {
    const path = "note.md";
    const baseBody = "one\ntwo\nthree\nfour\nfive\n";
    const remoteBody = "ONE\ntwo\nTHREE\nfour\nfive\n";
    const localBody = initial === "identical" ? remoteBody : "ONE\ntwo\nthree\nfour\nfive\n";
    const laterBody = localBody.replace("five", "FIVE");
    const finalBody = remoteBody.replace("five", "FIVE");
    const remoteHash = await hashText(remoteBody);
    const store = createTestSyncStore();
    const vault = createVaultAdapter({ [path]: localBody });
    const encode = (body: string) => new TextEncoder().encode(body);
    await arrangePendingUpsertWithCachedBase(store, {
      entryId: "note", path, baseRevision: 2, baseBlobId: "base",
      baseHash: await hashText(baseBody), baseBytes: encode(baseBody),
      localBlobId: "local", localHash: await hashText(localBody), createdAt: 3,
    });
    const commit = createCommit({
      cursor: 3, entryId: "note", revision: 3, blobId: "remote",
      encryptedMetadata: await encryptRemoteMetadata({
        entryId: "note", revision: 3, blobId: "remote", path, hash: remoteHash,
      }),
    });
    let saved = false;
    const service = new SyncPullService({
      contentRuntime: createTestContentRuntime(), getSyncToken: async () => createToken(),
      getSyncStore: () => store, getRemoteVaultKey: () => TEST_VAULT_KEY,
      vaultAdapter: vault, onProgress: ignoreProgress,
      blobClient: createBlobClient({ blobs: { remote: await encryptTestBlob("remote", encode(remoteBody)) } }),
      onFileSyncStarted() {
        if (!saved) {
          saved = true;
          vault.files.set(path, encode(laterBody));
        }
      },
    });
    const session = createRealtimeSession({ pages: [{ cursor: 3, hasMore: false, commits: [commit] }] });
    await expect(service.pullOnce(session)).resolves.toMatchObject({ cursor: 3, conflictsCreated: 0 });
    expect(vault.text(path)).toBe(finalBody);
    expect(await store.getDirtyEntryMutation("note")).toMatchObject({
      baseRevision: 3, baseHash: remoteHash, hash: await hashText(finalBody),
    });
    await store.close();
  });

  it.each([
    { name: "independent lines", policy: undefined, ...independentEdits },
    { name: "independent lines", policy: "prefer-remote", ...independentEdits },
    {
      name: "first-line insertion in a note with a BOM", policy: "prefer-remote",
      baseBody: "\uFEFFone\ntwo\n", localBody: "\uFEFFintro\none\ntwo\n",
      remoteBody: "\uFEFFONE\ntwo\n", mergedBody: "\uFEFFintro\nONE\ntwo\n",
    },
    {
      name: "note containing Unicode line and paragraph separators", policy: "prefer-remote",
      baseBody: "\uFEFFkeep\u2028also keep\u2029a\nb\nc\n", localBody: "\uFEFFkeep\u2028also keep\u2029A\nb\nc\n",
      remoteBody: "\uFEFFkeep\u2028also keep\u2029a\nb\nC\n", mergedBody: "\uFEFFkeep\u2028also keep\u2029A\nb\nC\n",
    },
  ] as const)("rebases $name before applying conflict policy $policy", async ({ policy, baseBody, localBody, remoteBody, mergedBody }) => {
    const store = createTestSyncStore();
    const baseHash = await hashText(baseBody);
    const localHash = await hashText(localBody);
    const remoteHash = await hashText(remoteBody);
    const mergedHash = await hashText(mergedBody);
    const adapter = createVaultAdapter({
      "Folder/note.md": localBody,
    });
    await arrangePendingUpsertWithCachedBase(store, {
      entryId: "entry-note",
      path: "Folder/note.md",
      baseRevision: 2,
      baseBlobId: "blob-base",
      baseHash,
      baseBytes: new TextEncoder().encode(baseBody),
      localBlobId: "blob-local",
      localHash,
      createdAt: 3,
    });

    const conflicts: PullConflictSummary[] = [];
    const session = createRealtimeSession({
      pages: [
        {
          cursor: 3,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 3,
              entryId: "entry-note",
              revision: 3,
              blobId: "blob-remote",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-note",
                revision: 3,
                blobId: "blob-remote",
                path: "Folder/note.md",
                hash: remoteHash,
              }),
            }),
          ],
        },
      ],
    });
    const client = createBlobClient({
      blobs: {
        "blob-remote": await encryptTestBlob(
          "blob-remote",
          new TextEncoder().encode(remoteBody),
        ),
      },
    });

    const service = new SyncPullService({
      contentRuntime: createTestContentRuntime({ maxBytesInFlight: 1 }),
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      getConflictPolicy: policy === undefined ? undefined : () => policy,
      vaultAdapter: adapter,
      blobClient: client,
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
      entriesApplied: 1,
      filesWritten: 1,
      filesDeleted: 0,
      conflictsCreated: 0,
    });
    expect(await adapter.readBytes("Folder/note.md")).toEqual(new TextEncoder().encode(mergedBody));
    expect(conflicts).toEqual([]);
    expect(await store.getRemoteStateById("entry-note")).toMatchObject({
      revision: 3,
      blobId: "blob-remote",
      hash: remoteHash,
    });
    expect(await store.getLocalStateById("entry-note")).toMatchObject({
      blobId: expect.any(String),
      hash: mergedHash,
    });
    expect(await store.listDirtyEntries()).toMatchObject([
      {
        entryId: "entry-note",
        op: "upsert",
        baseRevision: 3,
        baseBlobId: "blob-remote",
        baseHash: remoteHash,
        hash: mergedHash,
      },
    ]);
    expect(await store.getBlob("blob-remote")).toMatchObject({
      blobId: "blob-remote",
      hash: remoteHash,
    });

    await store.close();
  });

  it.each([undefined, "conflict-copy", "prefer-remote"] as const)("resolves overlapping markdown edits with policy %s", async (policy) => {
    const store = createTestSyncStore();
    const baseBody = "one\n";
    const localBody = "local\n";
    const remoteBody = "remote\n";
    const baseHash = await hashText(baseBody);
    const localHash = await hashText(localBody);
    const remoteHash = await hashText(remoteBody);
    const adapter = createVaultAdapter({
      "Folder/note.md": localBody,
    });
    await arrangePendingUpsertWithCachedBase(store, {
      entryId: "entry-note",
      path: "Folder/note.md",
      baseRevision: 2,
      baseBlobId: "blob-base",
      baseHash,
      baseBytes: new TextEncoder().encode(baseBody),
      localBlobId: "blob-local",
      localHash,
      createdAt: 3,
    });

    const conflicts: PullConflictSummary[] = [];
    const session = createRealtimeSession({
      pages: [
        {
          cursor: 3,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 3,
              entryId: "entry-note",
              revision: 3,
              blobId: "blob-remote",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-note",
                revision: 3,
                blobId: "blob-remote",
                path: "Folder/note.md",
                hash: remoteHash,
              }),
            }),
          ],
        },
      ],
    });
    const client = createBlobClient({
      blobs: {
        "blob-remote": await encryptTestBlob(
          "blob-remote",
          new TextEncoder().encode(remoteBody),
        ),
      },
    });

    const service = new SyncPullService({
      contentRuntime: createTestContentRuntime(),
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      getConflictPolicy: policy === undefined ? undefined : () => policy,
      vaultAdapter: adapter,
      blobClient: client,
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
      entriesApplied: 1,
      filesWritten: 1,
      filesDeleted: 0,
      conflictsCreated: policy === "prefer-remote" ? 0 : 1,
    });
    expect(adapter.text("Folder/note.md")).toBe(remoteBody);
    expect(adapter.text("Folder/note.sync-conflict-20260422-101112.md")).toBe(
      policy === "prefer-remote" ? null : localBody,
    );
    expect(await store.getRemoteStateById("entry-note")).toMatchObject({
      revision: 3,
      blobId: "blob-remote",
      hash: remoteHash,
    });
    expect(await store.listDirtyEntries()).toEqual([]);
    expect(conflicts).toEqual([
      {
        entryId: "entry-note",
        reason: "local_pending_mutation",
        originalPath: "Folder/note.md",
        conflictPath: policy === "prefer-remote" ? null : "Folder/note.sync-conflict-20260422-101112.md",
      },
    ]);

    await store.close();
  });

  it.each([undefined, "prefer-remote"] as const)("resolves non-mergeable binary paths with policy %s", async (policy) => {
    const store = createTestSyncStore();
    const path = "Folder/image.png";
    const conflictPath = "Folder/image.sync-conflict-20260422-101112.png";
    const baseBytes = new Uint8Array([0, 1, 2, 3]);
    const localBytes = new Uint8Array([0, 1, 9, 3]);
    const remoteBytes = new Uint8Array([0, 8, 2, 3]);
    const baseHash = await hashBytes(baseBytes);
    const localHash = await hashBytes(localBytes);
    const remoteHash = await hashBytes(remoteBytes);
    const adapter = createVaultAdapter({
      [path]: localBytes,
    });
    await arrangePendingUpsertWithCachedBase(store, {
      entryId: "entry-image",
      path,
      baseRevision: 2,
      baseBlobId: "blob-base",
      baseHash,
      baseBytes,
      localBlobId: "blob-local",
      localHash,
      createdAt: 3,
    });

    const conflicts: PullConflictSummary[] = [];
    const session = createRealtimeSession({
      pages: [
        {
          cursor: 3,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 3,
              entryId: "entry-image",
              revision: 3,
              blobId: "blob-remote",
              encryptedMetadata: await encryptRemoteMetadata({
                entryId: "entry-image",
                revision: 3,
                blobId: "blob-remote",
                path,
                hash: remoteHash,
              }),
            }),
          ],
        },
      ],
    });
    const client = createBlobClient({
      blobs: {
        "blob-remote": await encryptTestBlob("blob-remote", remoteBytes),
      },
    });

    const service = new SyncPullService({
      contentRuntime: createTestContentRuntime(),
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      getConflictPolicy: policy === undefined ? undefined : () => policy,
      vaultAdapter: adapter,
      blobClient: client,
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
      entriesApplied: 1,
      filesWritten: 1,
      filesDeleted: 0,
      conflictsCreated: policy === "prefer-remote" ? 0 : 1,
    });
    expect(adapter.bytes(path)).toEqual(remoteBytes);
    expect(adapter.bytes(conflictPath)).toEqual(policy === "prefer-remote" ? null : localBytes);
    expect(await store.getRemoteStateById("entry-image")).toMatchObject({
      revision: 3,
      blobId: "blob-remote",
      hash: remoteHash,
    });
    expect(await store.listDirtyEntries()).toEqual([]);
    expect(conflicts).toEqual([
      {
        entryId: "entry-image",
        reason: "local_pending_mutation",
        originalPath: path,
        conflictPath: policy === "prefer-remote" ? null : conflictPath,
      },
    ]);

    await store.close();
  });
});
