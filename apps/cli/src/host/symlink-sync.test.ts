import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  DEFAULT_SYNC_FILE_RULES,
  SyncContentRuntime,
  encryptSyncBlob,
  encryptSyncMetadata,
  hashBytes,
} from "@synch/sync-client/core";
import type { RemoteEntryState } from "../../../../packages/sync-client/src/sync/remote/changes";
import type { SyncRealtimeSession } from "../../../../packages/sync-client/src/sync/remote/realtime-types";
import { SyncPullService } from "../../../../packages/sync-client/src/sync/engine/pull-service";
import { SyncLocalReconcileService } from "../../../../packages/sync-client/src/sync/engine/local-reconcile-service";
import { SyncPushService } from "../../../../packages/sync-client/src/sync/engine/push-service";
import { SyncEventRecorder } from "../../../../packages/sync-client/src/sync/engine/event-recorder";
import { NodeSyncVaultAdapter } from "./vault-adapter";
import { SqliteSyncStore } from "./sqlite-store";

const key = new Uint8Array(32).fill(7);
const token = {
  token: "test",
  vaultId: "vault",
  localVaultId: "local",
  expiresAt: 1000,
};
let temporary: string;
let vault: string;
let outside: string;
let store: SqliteSyncStore;
let adapter: NodeSyncVaultAdapter;
let runtime: SyncContentRuntime;
let remotes: RemoteEntryState[];
let blobs: Map<string, Uint8Array>;

beforeEach(async () => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), "synch-exclusions-"));
  vault = path.join(temporary, "vault");
  outside = path.join(temporary, "outside");
  fs.mkdirSync(vault);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "note.md"), "outside original");
  fs.symlinkSync(outside, path.join(vault, "linked"), "dir");
  store = SqliteSyncStore.open(path.join(temporary, "sync.sqlite"));
  await store.writeSyncConnection({
    localVaultId: await store.readLocalVaultId(),
    remoteVaultId: "vault",
    lastPulledCursor: 0,
  });
  adapter = new NodeSyncVaultAdapter({
    vaultPath: vault,
    getConfigDir: () => ".obsidian",
    getSyncFileRules: () => DEFAULT_SYNC_FILE_RULES,
  });
  runtime = new SyncContentRuntime();
  remotes = [];
  blobs = new Map();
});

afterEach(async () => {
  try {
    expect(fs.readdirSync(outside)).toEqual(["note.md"]);
    expect(fs.readFileSync(path.join(outside, "note.md"), "utf8")).toBe(
      "outside original",
    );
  } finally {
    await store.close();
    await runtime.dispose();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

async function remote(
  filePath: string,
  id: string,
  seq: number,
  content: string | null = "remote",
  revision = 1,
) {
  const bytes = new TextEncoder().encode(content ?? "");
  const hash = content === null ? null : await hashBytes(bytes);
  const blobId = content === null ? null : `blob-${id}-${revision}`;
  if (blobId) blobs.set(blobId, await encryptSyncBlob(key, bytes, { blobId }));
  const state: RemoteEntryState = {
    entryId: id,
    revision,
    blobId,
    deleted: content === null,
    updatedSeq: seq,
    updatedAt: seq,
    encryptedMetadata: await encryptSyncMetadata(
      key,
      { path: filePath, hash },
      {
        entryId: id,
        revision,
        op: content === null ? "delete" : "upsert",
        blobId,
      },
    ),
  };
  remotes = [...remotes.filter((entry) => entry.entryId !== id), state];
  return {
    entryId: id,
    path: filePath,
    revision,
    blobId,
    hash,
    deleted: content === null,
    updatedAt: seq,
    localMtime: null,
    localSize: null,
  };
}

function pull() {
  const listEntryStates = vi.fn(
    async ({ sinceCursor }: { sinceCursor: number }) => ({
      entries: remotes.filter((entry) => entry.updatedSeq > sinceCursor),
      targetCursor: Math.max(0, ...remotes.map((entry) => entry.updatedSeq)),
      totalEntries: remotes.length,
      hasMore: false,
      nextAfter: null,
    }),
  );
  const downloadBlob = vi.fn(async (_vaultId: string, blobId: string) => {
    const blob = blobs.get(blobId);
    if (!blob) throw new Error(`Unexpected blob: ${blobId}`);
    return blob;
  });
  const service = new SyncPullService({
    contentRuntime: runtime,
    getSyncStore: () => store,
    getSyncToken: async () => token,
    getRemoteVaultKey: () => key,
    vaultAdapter: adapter,
    blobClient: { downloadBlob },
  });
  return {
    listEntryStates,
    downloadBlob,
    run: () =>
      service.pullOnce({ listEntryStates } as unknown as SyncRealtimeSession),
  };
}

function reconcile() {
  return new SyncLocalReconcileService({
    contentRuntime: runtime,
    getSyncStore: () => store,
    getRemoteVaultKey: () => key,
    scanner: adapter,
    shouldSyncPath: (filePath) => adapter.isSyncablePath(filePath),
  }).reconcileOnce();
}

it("skips linked downloads while applying other files and advancing the cursor", async () => {
  await remote("linked/new/incoming.md", "excluded", 1);
  await remote("normal.md", "normal", 2);
  const sync = pull();
  await expect(sync.run()).resolves.toMatchObject({
    cursor: 2,
    filesWritten: 1,
  });
  expect(fs.readFileSync(path.join(vault, "normal.md"), "utf8")).toBe("remote");
  expect(sync.downloadBlob).toHaveBeenCalledTimes(1);
  expect(await store.getRemoteStateById("excluded")).toMatchObject({
    revision: 1,
  });
  expect(await store.getLocalStateById("excluded")).toBeNull();
  await expect(reconcile()).resolves.toMatchObject({ filesQueuedForDelete: 0 });
});

it("keeps legacy unsafe remote paths excluded during subsequent reconciliation", async () => {
  await remote("bad:name.md", "incompatible", 1);
  await remote("../outside/note.md", "traversal", 2);
  await expect(pull().run()).resolves.toMatchObject({ cursor: 2, filesWritten: 0 });
  await expect(reconcile()).resolves.toMatchObject({ filesQueuedForDelete: 0 });
  expect(await store.listDirtyEntries()).toEqual([]);
});

it.skipIf(process.platform === "win32")("reconciles normal files alongside excluded local names", async () => {
  await store.upsertEntry(await remote("bad:name.md", "excluded-name", 1));
  fs.writeFileSync(path.join(vault, "bad:name.md"), "excluded local content");
  fs.writeFileSync(path.join(vault, "normal.md"), "normal local content");

  await expect(reconcile()).resolves.toMatchObject({
    filesScanned: 1,
    filesQueuedForUpsert: 1,
    filesQueuedForDelete: 0,
  });
  expect(await store.getLocalStateById("excluded-name")).toBeNull();
  expect(await store.getRemoteStateById("excluded-name")).toMatchObject({ deleted: false });
  expect(fs.readFileSync(path.join(vault, "bad:name.md"), "utf8")).toBe("excluded local content");
});

it("queues the missing child deletion after replacing a tracked directory with a file", async () => {
  await store.upsertEntry(await remote("folder/note.md", "old-child", 1));
  fs.writeFileSync(path.join(vault, "folder"), "replacement");
  fs.writeFileSync(path.join(vault, "normal.md"), "unrelated local content");

  await expect(reconcile()).resolves.toMatchObject({
    filesQueuedForUpsert: 1,
    filesQueuedForDelete: 1,
  });
  expect(await store.getDirtyEntryMutation("old-child")).toMatchObject({ op: "delete" });
  expect(fs.readFileSync(path.join(vault, "folder"), "utf8")).toBe("replacement");
});

it("does not turn previously synced excluded files into deletes or rename candidates", async () => {
  const row = await remote("linked/note.md", "excluded", 1);
  await store.upsertEntry(row);
  fs.writeFileSync(path.join(vault, "normal.md"), "remote");
  await expect(reconcile()).resolves.toMatchObject({
    filesQueuedForDelete: 0,
    filesQueuedForUpsert: 1,
  });
  expect(await store.getLocalStateById("excluded")).toBeNull();
  expect(await store.getRemoteStateById("excluded")).toMatchObject({
    deleted: false,
  });
  const pending = await store.listDirtyEntries();
  expect(pending).toHaveLength(1);
  expect(pending[0]!.entryId).not.toBe("excluded");
});

it("recovers excluded downloads after restart using the latest server snapshot", async () => {
  await store.upsertEntry(await remote("linked/note.md", "excluded", 1));
  await reconcile();
  await pull().run();
  expect(await store.getCursor()).toBe(1);
  await store.close();
  store = SqliteSyncStore.open(path.join(temporary, "sync.sqlite"));
  fs.unlinkSync(path.join(vault, "linked"));
  fs.mkdirSync(path.join(vault, "linked"));
  await expect(reconcile()).resolves.toMatchObject({ filesQueuedForDelete: 0 });
  await remote("linked/note.md", "excluded", 2, "latest remote", 2);
  const sync = pull();
  await expect(sync.run()).resolves.toMatchObject({ filesWritten: 1 });
  expect(sync.listEntryStates).toHaveBeenLastCalledWith(
    expect.objectContaining({ sinceCursor: 0 }),
  );
  expect(fs.readFileSync(path.join(vault, "linked/note.md"), "utf8")).toBe(
    "latest remote",
  );
  await sync.run();
  expect(sync.listEntryStates).toHaveBeenLastCalledWith(
    expect.objectContaining({ sinceCursor: 2 }),
  );
  expect(sync.downloadBlob).toHaveBeenCalledTimes(1);
});

it("recovers a skipped revision even when no new remote change arrives", async () => {
  await remote("linked/note.md", "excluded", 1);
  await pull().run();
  fs.unlinkSync(path.join(vault, "linked"));
  const sync = pull();
  await expect(sync.run()).resolves.toMatchObject({
    cursor: 1,
    filesWritten: 1,
  });
  expect(fs.readFileSync(path.join(vault, "linked/note.md"), "utf8")).toBe(
    "remote",
  );
});

it("skips tombstones under a link without blocking unrelated downloads", async () => {
  await store.upsertEntry(await remote("linked/note.md", "excluded", 1));
  await remote("linked/note.md", "excluded", 2, null, 2);
  await remote("normal.md", "normal", 3);
  await expect(pull().run()).resolves.toMatchObject({
    cursor: 3,
    filesDeleted: 0,
    filesWritten: 1,
  });
  expect(await store.getLocalStateById("excluded")).toBeNull();
  fs.unlinkSync(path.join(vault, "linked"));
  const sync = pull();
  await sync.run();
  await sync.run();
  expect(sync.listEntryStates).toHaveBeenLastCalledWith(
    expect.objectContaining({ sinceCursor: 3 }),
  );
});

it("downloads a remote rename out of a linked tree without moving the external file", async () => {
  await store.upsertEntry(await remote("linked/note.md", "excluded", 1));
  await remote("normal.md", "excluded", 2, "moved remote", 2);
  await expect(pull().run()).resolves.toMatchObject({
    filesWritten: 1,
    filesDeleted: 0,
  });
  expect(fs.readFileSync(path.join(vault, "normal.md"), "utf8")).toBe(
    "moved remote",
  );
});

it.each(["upsert", "delete"] as const)(
  "discards pending %s operations under a link without contacting the server",
  async (op) => {
    const row = await remote("linked/note.md", "excluded", 1);
    await store.upsertEntry(row);
    await store.markEntryDirty({
      mutationId: "pending",
      entryId: row.entryId,
      op,
      baseRevision: 1,
      blobId: op === "delete" ? null : row.blobId,
      hash: op === "delete" ? null : row.hash,
      encryptedMetadata: await encryptSyncMetadata(
        key,
        {
          path: row.path,
          hash: op === "delete" ? null : row.hash,
        },
        {
          entryId: row.entryId,
          revision: 2,
          op,
          blobId: op === "delete" ? null : row.blobId,
        },
      ),
      createdAt: 2,
    });
    const commitMutations = vi.fn();
    const uploadBlob = vi.fn();
    const onFileSyncFailed = vi.fn();
    const service = new SyncPushService({
      contentRuntime: runtime,
      getSyncStore: () => store,
      getSyncToken: async () => token,
      getRemoteVaultKey: () => key,
      fileReader: adapter,
      conflictFileWriter: adapter,
      blobClient: { uploadBlob },
      onFileSyncFailed,
    });
    await expect(
      service.pushPendingMutations({
        commitMutations,
        maxFileSizeBytes: 0,
      } as unknown as SyncRealtimeSession),
    ).resolves.toMatchObject({ mutationsPushed: 0, hasMore: false });
    expect(uploadBlob).not.toHaveBeenCalled();
    expect(commitMutations).not.toHaveBeenCalled();
    expect(onFileSyncFailed).not.toHaveBeenCalled();
    expect(await store.getLocalStateById("excluded")).toBeNull();
    expect(await store.getRemoteStateById("excluded")).toMatchObject({
      deleted: false,
    });
  },
);

it("does not propagate watcher deletes for remote-only excluded entries", async () => {
  await remote("linked/note.md", "excluded", 1);
  await pull().run();
  const recorder = new SyncEventRecorder({
    contentRuntime: runtime,
    getSyncStore: () => store,
    getRemoteVaultKey: () => key,
    requireLocalStateForDelete: true,
  });
  expect(await recorder.recordDelete("linked/note.md")).toBe(false);
  expect(await store.listDirtyEntries()).toEqual([]);
});

it("clears an already queued delete when its path becomes excluded", async () => {
  const row = await remote("linked/note.md", "excluded", 1);
  await store.upsertEntry(row);
  const recorder = new SyncEventRecorder({
    contentRuntime: runtime,
    getSyncStore: () => store,
    getRemoteVaultKey: () => key,
  });
  await recorder.recordDelete(row.path);
  expect((await store.getLocalStateById(row.entryId))?.path).toBeNull();
  await expect(reconcile()).resolves.toMatchObject({ filesQueuedForDelete: 0 });
  expect(await store.getDirtyEntryMutation(row.entryId)).toBeNull();
  expect(await store.getLocalStateById(row.entryId)).toBeNull();
  expect(await store.getRemoteStateById(row.entryId)).toMatchObject({
    deleted: false,
  });
});

it("continues uploading normal files when another queued upload becomes excluded", async () => {
  const recorder = new SyncEventRecorder({
    contentRuntime: runtime,
    getSyncStore: () => store,
    getRemoteVaultKey: () => key,
  });
  const content = new TextEncoder().encode("local");
  // A mutation may have been queued before the link was installed.
  await recorder.recordUpsert("linked/note.md", content);
  fs.writeFileSync(path.join(vault, "normal.md"), content);
  await recorder.recordUpsert("normal.md", content);
  const uploadBlob = vi.fn(async () => {});
  const commitMutations = vi.fn(async (mutations) => ({
    cursor: 1,
    results: mutations.map(
      (mutation: { mutationId: string; entryId: string }) => ({
        mutationId: mutation.mutationId,
        entryId: mutation.entryId,
        status: "accepted",
        revision: 1,
        cursor: 1,
      }),
    ),
  }));
  const service = new SyncPushService({
    contentRuntime: runtime,
    getSyncStore: () => store,
    getSyncToken: async () => token,
    getRemoteVaultKey: () => key,
    fileReader: adapter,
    conflictFileWriter: adapter,
    blobClient: { uploadBlob },
  });
  await expect(
    service.pushPendingMutations({
      commitMutations,
      maxFileSizeBytes: 0,
    } as unknown as SyncRealtimeSession),
  ).resolves.toMatchObject({ mutationsPushed: 1, hasMore: false });
  expect(uploadBlob).toHaveBeenCalledTimes(1);
  expect(commitMutations).toHaveBeenCalledTimes(1);
  expect(commitMutations.mock.calls[0]![0]).toHaveLength(1);
});
