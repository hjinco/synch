import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { DEFAULT_SYNC_FILE_RULES, SyncContentRuntime } from "@synch/sync-client/core";
import { NodeSyncVaultAdapter } from "./vault-adapter";
import { SqliteSyncStore } from "./sqlite-store";
import { SyncPullService } from "../../../../packages/sync-client/src/sync/engine/pull-service";
import {
  createBlobClient, createCommit, createRealtimeSession, createToken, encryptRemoteMetadata,
  encryptTestBlob, hashText, TEST_VAULT_KEY,
} from "../../../../packages/sync-client/src/sync/engine/__tests__/pull-service/helpers";

let vaultPath: string;
let note: string;
let adapter: NodeSyncVaultAdapter;

function openVault() {
  return new NodeSyncVaultAdapter({
    vaultPath, getConfigDir: () => ".obsidian", getSyncFileRules: () => DEFAULT_SYNC_FILE_RULES,
  });
}

beforeEach(async () => {
  vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), "synch-conditional-write-"));
  note = path.join(await fs.realpath(vaultPath), "note.md");
  await fs.writeFile(note, "original");
  adapter = openVault();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(vaultPath, { recursive: true, force: true });
});

it("leaves a live writer's captured source alone during a recovery check", async () => {
  const captured = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const link = fs.link.bind(fs);
  vi.spyOn(fs, "link").mockImplementation(async (from, to) => {
    if (to === note) {
      captured.resolve();
      await resume.promise;
    }
    await link(from, to);
  });
  const write = adapter.writeTextIfUnchanged("note.md", "original", "merged");
  await captured.promise;
  try {
    await adapter.recoverInterruptedWrites();
    await expect(fs.stat(note)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    resume.resolve();
    await write;
  }
  expect(await fs.readFile(note, "utf8")).toBe("merged");
});

it.each([false, true])("keeps an editor save immediately before capture (atomic save: %s)", async (atomic) => {
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, "rename").mockImplementationOnce(async (from, to) => {
    if (atomic) {
      const editorTemp = path.join(vaultPath, "editor.tmp");
      await fs.writeFile(editorTemp, "editor save");
      await rename(editorTemp, note);
    } else {
      await fs.writeFile(note, "editor save");
    }
    await rename(from, to);
  });
  expect(await adapter.writeTextIfUnchanged("note.md", "original", "merged")).toBe(false);
  expect(await fs.readFile(note, "utf8")).toBe("editor save");
  expect(await adapter.writeTextIfUnchanged("note.md", "editor save", "replanned")).toBe(true);
  expect(await fs.readFile(note, "utf8")).toBe("replanned");
});

it("keeps a file recreated while the source is held", async () => {
  const link = fs.link.bind(fs);
  vi.spyOn(fs, "link").mockImplementation(async (from, to) => {
    if (to === note && path.basename(String(from)) === "replacement") {
      await fs.writeFile(note, "editor save", { flag: "wx" });
    }
    await link(from, to);
  });
  expect(await adapter.writeTextIfUnchanged("note.md", "original", "merged")).toBe(false);
  expect(await fs.readFile(note, "utf8")).toBe("editor save");
});

it("preserves a save through an open descriptor that completes before installation", async () => {
  const editor = await fs.open(note, "r+");
  try {
    const link = fs.link.bind(fs);
    vi.spyOn(fs, "link").mockImplementation(async (from, to) => {
      if (to === note && path.basename(String(from)) === "replacement") {
        await editor.truncate(0);
        await editor.writeFile("editor save");
      }
      await link(from, to);
    });
    expect(await adapter.writeTextIfUnchanged("note.md", "original", "merged")).toBe(true);
    expect(await fs.readFile(note, "utf8")).toBe("merged");
    const copies = (await fs.readdir(vaultPath)).filter((name) => name.includes(".sync-conflict-"));
    expect(copies).toHaveLength(1);
    expect(adapter.isSyncablePath(copies[0]!)).toBe(false);
    expect(await fs.readFile(path.join(vaultPath, copies[0]!), "utf8")).toBe("editor save");
  } finally {
    await editor.close();
  }
});

it.each([false, true])("reopens an interrupted capture with a competing destination: %s", async (competing) => {
  const link = fs.link.bind(fs);
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, "rename").mockImplementationOnce(async (from, to) => {
    await fs.writeFile(note, "changed just before capture");
    await rename(from, to);
  });
  vi.spyOn(fs, "link").mockImplementation(async (from, to) => {
    if (to === note) throw new Error("interrupted while restoring the source");
    await link(from, to);
  });
  await expect(adapter.writeTextIfUnchanged("note.md", "original", "merged")).rejects.toThrow("interrupted");
  await expect(fs.stat(note)).rejects.toMatchObject({ code: "ENOENT" });
  if (competing) await fs.writeFile(note, "new destination", { flag: "wx" });
  vi.restoreAllMocks();

  const reopened = openVault();
  await reopened.recoverInterruptedWrites();
  await reopened.recoverInterruptedWrites();
  expect(await fs.readFile(note, "utf8")).toBe(competing ? "new destination" : "changed just before capture");
  const copies = (await fs.readdir(vaultPath)).filter((name) => name.includes(".sync-conflict-"));
  expect(copies).toHaveLength(competing ? 1 : 0);
  if (competing) expect(await fs.readFile(path.join(vaultPath, copies[0]!), "utf8")).toBe("changed just before capture");
  expect(await fs.readdir(path.join(vaultPath, ".synch/merge-writes"))).toEqual([]);
});

it("preserves a deletion after a completed install interrupted during cleanup", async () => {
  const remove = fs.rm.bind(fs);
  vi.spyOn(fs, "rm").mockImplementationOnce(async (file, options) => {
    if (path.basename(String(file)) === "source") throw new Error("interrupted cleanup");
    await remove(file, options);
  });
  await expect(adapter.writeTextIfUnchanged("note.md", "original", "merged")).rejects.toThrow("interrupted cleanup");
  expect(await fs.readFile(note, "utf8")).toBe("merged");
  await fs.unlink(note);
  await openVault().recoverInterruptedWrites();
  await expect(fs.stat(note)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["EOPNOTSUPP", "EXDEV"])("leaves the source for the engine to preserve on %s", async (code) => {
  const error = Object.assign(new Error("unsupported filesystem"), { code });
  if (code === "EXDEV") vi.spyOn(fs, "rename").mockRejectedValueOnce(error);
  else vi.spyOn(fs, "link").mockRejectedValueOnce(error);
  expect(await adapter.writeTextIfUnchanged("note.md", "original", "merged")).toBe(false);
  expect(adapter.canCompareTextForWrite("original", "note.md")).toBe(false);
  expect(adapter.canCompareTextForWrite("original", "other/note.md")).toBe(true);
  expect(await fs.readFile(note, "utf8")).toBe("original");
});

it.each(["editor save", "restart", "watch retry", "unsupported volume"])("finishes the CLI pull after %s", async (scenario) => {
  const sqlite = path.join(vaultPath, ".synch", "sync.sqlite");
  let store = SqliteSyncStore.open(sqlite);
  const runtime = new SyncContentRuntime();
  const remote = "REMOTE\nbase\ntail\n";
  const local = "title\nbase\nLOCAL\n";
  const merged = "REMOTE\nbase\nLOCAL\n";
  const blobs: Record<string, Uint8Array> = {};
  function createService() {
    return new SyncPullService({
      contentRuntime: runtime, getSyncStore: () => store, getRemoteVaultKey: () => TEST_VAULT_KEY,
      getSyncToken: async () => createToken(), vaultAdapter: adapter, blobClient: createBlobClient({ blobs }),
    });
  }
  let service = createService();
  async function pull(revision: number, body: string) {
    const blobId = String(revision);
    const commit = createCommit({
      entryId: "note", cursor: revision, revision, blobId,
      encryptedMetadata: await encryptRemoteMetadata({
        entryId: "note", revision, blobId, path: "note.md", hash: await hashText(body),
      }),
    });
    blobs[blobId] = await encryptTestBlob(blobId, new TextEncoder().encode(body));
    return await service.pullOnce(createRealtimeSession({
      pages: [{ cursor: revision, hasMore: false, commits: [commit] }],
    }));
  }
  try {
    await store.writeSyncConnection({
      localVaultId: await store.readLocalVaultId(), remoteVaultId: "vault-1", lastPulledCursor: 0,
    });
    await fs.unlink(note);
    await pull(1, "title\nbase\ntail\n");
    await fs.writeFile(note, local);
    let expected = merged;
    if (scenario === "editor save") {
      const rename = fs.rename.bind(fs);
      vi.spyOn(fs, "rename").mockImplementationOnce(async (from, to) => {
        const editor = path.join(vaultPath, "editor.tmp");
        await fs.writeFile(editor, local + "just saved\n");
        await rename(editor, note);
        await rename(from, to);
      });
      expected += "just saved\n";
    } else if (scenario === "restart" || scenario === "watch retry") {
      const link = fs.link.bind(fs);
      vi.spyOn(fs, "link").mockImplementation(async (from, to) => {
        if (to === note) throw new Error("interrupted with source held");
        await link(from, to);
      });
      await expect(pull(2, remote)).rejects.toThrow("interrupted with source held");
      expect(await store.getCursor()).toBe(1);
      await expect(fs.stat(note)).rejects.toMatchObject({ code: "ENOENT" });
      if (scenario === "watch retry") {
        await expect(service.recoverPendingWrites()).rejects.toThrow("interrupted with source held");
        expect(await store.textMerges.listEntryIds()).toEqual(["note"]);
      }
      vi.restoreAllMocks();
      if (scenario === "restart") {
        await store.close();
        adapter = openVault();
        await adapter.recoverInterruptedWrites();
        store = SqliteSyncStore.open(sqlite);
        service = createService();
      } else {
        await service.recoverPendingWrites();
        expect(await fs.readFile(note, "utf8")).toBe(local);
        expect(await store.getDirtyEntryMutation("note")).toMatchObject({ op: "upsert" });
      }
    } else {
      vi.spyOn(fs, "link").mockRejectedValueOnce(Object.assign(new Error("unsupported"), { code: "ENOTSUP" }));
      expected = local;
    }
    await expect(pull(2, remote)).resolves.toMatchObject({ cursor: 2 });
    expect(await fs.readFile(note, "utf8")).toBe(expected);
    expect(await store.getDirtyEntryMutation("note")).toMatchObject({
      baseRevision: 2, hash: await hashText(expected),
    });
    expect(await store.textMerges.listEntryIds()).toEqual([]);
    const copies = (await fs.readdir(vaultPath)).filter((name) => name.includes(".sync-conflict-"));
    expect(copies).toHaveLength(scenario === "unsupported volume" ? 1 : 0);
    if (copies.length) expect(await fs.readFile(path.join(vaultPath, copies[0]!), "utf8")).toBe(merged);
  } finally {
    await store.close();
    await runtime.dispose();
  }
});
