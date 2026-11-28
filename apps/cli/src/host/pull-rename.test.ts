import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SYNC_FILE_RULES, decryptSyncMetadata, SyncContentRuntime } from "@synch/sync-client/core";
import { SyncEventRecorder } from "../../../../packages/sync-client/src/sync/engine/event-recorder";
import { SyncLocalReconcileService } from "../../../../packages/sync-client/src/sync/engine/local-reconcile-service";
import { SyncPullService } from "../../../../packages/sync-client/src/sync/engine/pull-service";
import {
  createBlobClient, createCommit, createRealtimeSession, createToken,
  encryptRemoteMetadata, encryptTestBlob, hashText, TEST_VAULT_KEY,
} from "../../../../packages/sync-client/src/sync/engine/__tests__/pull-service/helpers";
import { SqliteSyncStore } from "./sqlite-store";
import { NodeSyncVaultAdapter } from "./vault-adapter";

let temporary: string;
let vault: string;
let adapter: NodeSyncVaultAdapter;
let store: SqliteSyncStore;
let contentRuntime: SyncContentRuntime;

beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "synch-rename-"));
  vault = path.join(temporary, "vault");
  await fs.mkdir(vault);
  adapter = new NodeSyncVaultAdapter({
    vaultPath: vault, getConfigDir: () => ".obsidian", getSyncFileRules: () => DEFAULT_SYNC_FILE_RULES,
  });
  store = SqliteSyncStore.open(path.join(temporary, "sync.sqlite"));
  await store.writeSyncConnection({
    localVaultId: await store.readLocalVaultId(), remoteVaultId: "vault-1", lastPulledCursor: 0,
  });
  contentRuntime = new SyncContentRuntime();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await store.close();
  await contentRuntime.dispose();
  await fs.rm(temporary, { recursive: true, force: true });
});

async function prepareRename(destination: string, remote: string, source = "note.md") {
  await fs.mkdir(path.dirname(path.join(vault, source)), { recursive: true });
  await adapter.writeText(source, "original");
  await store.upsertEntry({
    entryId: "note", path: source, revision: 1, blobId: "old", hash: await hashText("original"),
    deleted: false, updatedAt: 1, localMtime: null, localSize: null,
  });
  const commit = createCommit({
    entryId: "note", revision: 2, cursor: 2, blobId: "new",
    encryptedMetadata: await encryptRemoteMetadata({
      entryId: "note", revision: 2, blobId: "new", path: destination, hash: await hashText(remote),
    }),
  });
  const deps = { getSyncStore: () => store, getRemoteVaultKey: () => TEST_VAULT_KEY, contentRuntime };
  const service = new SyncPullService({
    ...deps, vaultAdapter: adapter, getSyncToken: async () => createToken(),
    blobClient: createBlobClient({ blobs: { new: await encryptTestBlob("new", new TextEncoder().encode(remote)) } }),
  });
  const reconcile = new SyncLocalReconcileService({
    ...deps, shouldSyncPath: () => true, scanner: adapter,
  });
  return {
    pull: () => service.pullOnce(createRealtimeSession({ pages: [{ cursor: 2, hasMore: false, commits: [commit] }] })),
    reconcile: () => reconcile.reconcileOnce(),
    async poll() {
      const session = createRealtimeSession({ pages: [{ cursor: 2, hasMore: false, commits: [] }] });
      const list = vi.spyOn(session, "listEntryStates");
      await service.pullOnce(session);
      return list.mock.calls[0]?.[0].sinceCursor;
    },
    recordEdit: async (name: string) => new SyncEventRecorder({
      ...deps, areSameFilePaths: adapter.areSameFilePaths.bind(adapter),
    }).recordUpsert(name, await adapter.readBytes(name)),
  };
}

it.each(["original", "edited remotely"])("keeps a case-only rename with content %s after the next scan", async (body) => {
  const { pull, reconcile } = await prepareRename("Note.md", body);
  await expect(pull()).resolves.toMatchObject({ cursor: 2, conflictsCreated: 0 });
  expect(await fs.readdir(vault)).toEqual(["Note.md"]);
  expect(await fs.readFile(path.join(vault, "Note.md"), "utf8")).toBe(body);
  await reconcile();
  expect(await store.listDirtyEntries()).toEqual([]);
});

it("keeps the original bytes available when a case-only rename's content update fails", async () => {
  const { pull, reconcile } = await prepareRename("Note.md", "edited remotely");
  vi.spyOn(adapter, "writeText").mockRejectedValueOnce(new Error("interrupted write"));
  await expect(pull()).rejects.toThrow("interrupted write");
  expect(await fs.readFile(path.join(vault, "Note.md"), "utf8")).toBe("original");
  await expect(pull()).resolves.toMatchObject({ cursor: 2, conflictsCreated: 0 });
  expect(await fs.readFile(path.join(vault, "Note.md"), "utf8")).toBe("edited remotely");
  await reconcile();
  expect(await store.listDirtyEntries()).toEqual([]);
});

it("updates the spelling of a directory containing only the moved note", async () => {
  const { pull, reconcile } = await prepareRename("Folder/Note.md", "edited remotely", "folder/note.md");
  await expect(pull()).resolves.toMatchObject({ cursor: 2, conflictsCreated: 0 });
  expect(await fs.readdir(vault)).toContain("Folder");
  expect(await fs.readdir(path.join(vault, "Folder"))).toEqual(["Note.md"]);
  await reconcile();
  expect(await store.listDirtyEntries()).toEqual([]);
});

it.each(["scan", "watcher"])("preserves a shared directory and its entry identity through a %s edit", async (origin) => {
  const remote = "Folder/note.md";
  const { pull, reconcile, poll, recordEdit } = await prepareRename(remote, "edited remotely", "folder/note.md");
  await adapter.writeText("folder/.private", "local");
  await expect(pull()).resolves.toMatchObject({ cursor: 2, conflictsCreated: 0 });
  expect(await fs.readdir(vault)).toContain("folder");
  expect(await fs.readFile(path.join(vault, "folder/.private"), "utf8")).toBe("local");
  expect(await fs.readFile(path.join(vault, remote), "utf8")).toBe("edited remotely");
  const disk = (await adapter.listFiles())[0]!.path;
  expect((await store.getLocalStateById("note"))?.path).toBe(disk);
  expect((await store.getRemoteStateById("note"))?.path).toBe(remote);
  expect(await poll()).toBe(2);
  await reconcile();
  expect(await store.listDirtyEntries()).toEqual([]);
  for (const text of ["first local edit", "another local edit"]) {
    await adapter.writeText(disk, text);
    if (origin === "watcher") await recordEdit(disk);
    else await reconcile();
    const dirty = await store.listDirtyEntries();
    expect(dirty).toHaveLength(1);
    const [edit] = dirty;
    expect(edit).toMatchObject({ entryId: "note", op: "upsert", baseRevision: 2 });
    await expect(decryptSyncMetadata(TEST_VAULT_KEY, edit!.encryptedMetadata, {
      entryId: "note", revision: 3, op: "upsert", blobId: edit!.blobId,
    })).resolves.toMatchObject({ path: remote, hash: await hashText(text) });
  }
});

it.each([false, true])("retries a remote rename after its write fails (intervening edit: %s)", async (edited) => {
  const { pull, reconcile } = await prepareRename("moved.md", "edited remotely");
  vi.spyOn(adapter, "writeText").mockRejectedValueOnce(new Error("interrupted write"));
  await expect(pull()).rejects.toThrow("interrupted write");
  expect(await fs.readdir(vault)).toEqual(["moved.md"]);
  expect(await fs.readFile(path.join(vault, "moved.md"), "utf8")).toBe("original");
  expect(await store.getCursor()).toBe(0);
  if (edited) await adapter.writeText("moved.md", "saved during retry");
  await expect(pull()).resolves.toMatchObject({ cursor: 2, conflictsCreated: edited ? 1 : 0 });
  const files = await fs.readdir(vault);
  if (edited) {
    const [copy] = files.filter((name) => name.includes(".sync-conflict-"));
    expect(await fs.readFile(path.join(vault, copy!), "utf8")).toBe("saved during retry");
  } else {
    expect(files).toEqual(["moved.md"]);
  }
  expect(await fs.readFile(path.join(vault, "moved.md"), "utf8")).toBe("edited remotely");
  await reconcile();
  expect(await store.getDirtyEntryMutation("note")).toBeNull();
});

it.each(["copy", "hard link"])("preserves a separate destination that matches the source (%s)", async (kind) => {
  const { pull } = await prepareRename("moved.md", "edited remotely");
  if (kind === "copy") await adapter.writeText("moved.md", "original");
  else await fs.link(path.join(vault, "note.md"), path.join(vault, "moved.md"));
  await expect(pull()).resolves.toMatchObject({ cursor: 2, conflictsCreated: 1 });
  const [copy] = (await fs.readdir(vault)).filter((name) => name.includes(".sync-conflict-"));
  expect(await fs.readFile(path.join(vault, copy!), "utf8")).toBe("original");
  expect(await fs.readFile(path.join(vault, "moved.md"), "utf8")).toBe("edited remotely");
});
