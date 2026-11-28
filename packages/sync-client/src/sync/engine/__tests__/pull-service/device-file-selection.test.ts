import { describe, expect, it, vi } from "vitest";
import { createTestContentRuntime } from "../../../../test-support/content-runtime";
import { createTestSyncStore } from "../../../../test-support/in-memory-sync-store";
import { DEFAULT_SYNC_FILE_RULES } from "../../../core/file-rules";
import { DEFAULT_VAULT_CONFIG_SYNC_RULES } from "../../../core/vault-config-rules";
import { isExcludedByDeviceFileRules } from "../../../core/vault-path-policy";
import { SyncLocalReconcileService } from "../../local-reconcile-service";
import { SyncPushService } from "../../push-service";
import { SyncPullService } from "../../pull-service";
import {
  createBlobClient, createCommit, createRealtimeSession, createToken, createVaultAdapter,
  encryptRemoteMetadata, encryptTestBlob, hashText, TEST_VAULT_KEY,
} from "./helpers";

function setup() {
  const store = createTestSyncStore();
  const vault = createVaultAdapter();
  const blobs: Record<string, Uint8Array> = {};
  const client = createBlobClient({ blobs });
  const download = vi.spyOn(client, "downloadBlob");
  const fileRules = { ...DEFAULT_SYNC_FILE_RULES, excludedFolders: ["Archive"], includePdf: false };
  const excludes = (path: string) => isExcludedByDeviceFileRules(path, {
    configDir: ".obsidian", vaultConfigRules: DEFAULT_VAULT_CONFIG_SYNC_RULES, fileRules,
  });
  const common = {
    getSyncStore: () => store, getRemoteVaultKey: () => TEST_VAULT_KEY,
    isDeviceFileExcluded: excludes, contentRuntime: createTestContentRuntime(),
  };
  const pull = (getDeviceFileRulesVersion?: () => number) => new SyncPullService({
    getDeviceFileRulesVersion,
    ...common, getSyncToken: async () => createToken(), vaultAdapter: vault, blobClient: client,
  });
  const reconcile = () => new SyncLocalReconcileService({
    ...common, shouldSyncPath: (path) => !excludes(path), scanner: {
      listFiles: async () => [...vault.files].filter(([path]) => !excludes(path)).map(([path, bytes]) =>
        ({ path, mtime: 1, size: bytes.length, readBytes: () => vault.readBytes(path) })),
    },
  }).reconcileOnce();
  async function commit(path: string, entryId: string, cursor: number, revision: number, contents: string | null) {
    const blobId = contents === null ? null : entryId + "-" + revision;
    if (blobId && contents !== null) blobs[blobId] = await encryptTestBlob(blobId, new TextEncoder().encode(contents));
    return createCommit({ entryId, revision, cursor, blobId, op: contents === null ? "delete" : "upsert",
      encryptedMetadata: await encryptRemoteMetadata({ path, entryId, revision, blobId,
        deleted: contents === null, hash: contents === null ? undefined : await hashText(contents) }),
    });
  }
  const uploadBlob = vi.fn(async () => {});
  const push = (realtime = session(0), getDeviceFileRulesVersion?: () => number) => new SyncPushService({
    getDeviceFileRulesVersion,
    ...common, getSyncToken: async () => createToken(), fileReader: vault, blobClient: { uploadBlob },
  }).pushPendingMutations(realtime);
  return { fileRules, pull, push, reconcile, commit, download, uploadBlob, store, vault };
}

function session(cursor: number, ...pages: ReturnType<typeof createCommit>[][]) {
  return createRealtimeSession({ pages: pages.map((commits) => ({ cursor, hasMore: false, commits })) });
}

describe("device file selection", () => {
  it.each(["remote", "independent local file"])("preserves edits at both ends of a returning rename (%s)", async (destination) => {
    const { commit, pull, reconcile, vault, store } = setup();
    await pull().pullOnce(session(1, [await commit("a.md", "x", 1, 1, "base")]));
    await pull().pullOnce(session(2, [await commit("Archive/a.md", "x", 2, 2, "archived")]));
    await vault.writeText("a.md", "local source edit");
    await vault.writeText("b.md", destination);
    await reconcile();
    await pull().pullOnce(session(3, [await commit("b.md", "x", 3, 3, "remote")]));
    expect(vault.text("b.md")).toBe("remote");
    const copies = [...vault.files.keys()].filter(path => path.includes(".sync-conflict-")).map(path => vault.text(path));
    const expected = destination === "remote" ? ["local source edit"] : [destination, "local source edit"];
    expect(copies.sort()).toEqual(expected.sort());
    expect(await store.listDirtyEntries()).toEqual([]);
  });

  it("downloads a returning file when its matching local namesake disappears after the scan", async () => {
    const { commit, pull, reconcile, vault, store, fileRules } = setup();
    const remote = await commit("paper.pdf", "pdf", 1, 1, "remote");
    await pull().pullOnce(session(1, [remote]));
    await vault.writeText("paper.pdf", "remote");
    fileRules.includePdf = true;
    await reconcile();
    await vault.remove("paper.pdf");

    await pull().pullOnce(session(1, [], [remote]));
    expect(vault.text("paper.pdf")).toBe("remote");
    expect(await store.listDirtyEntries()).toEqual([]);
    expect(await store.deferredFiles.list()).toEqual([]);
  });

  it("preserves a local namesake created after the inclusion scan", async () => {
    const { commit, pull, reconcile, vault, fileRules } = setup();
    const remote = await commit("paper.pdf", "pdf", 1, 1, "remote");
    await pull().pullOnce(session(1, [remote]));
    fileRules.includePdf = true;
    await reconcile();
    await vault.writeText("paper.pdf", "local only");
    const result = await pull().pullOnce(session(1, [], [remote]));
    expect(result.conflictsCreated).toBe(1);
    expect(vault.text("paper.pdf")).toBe("remote");
    const copies = [...vault.files.keys()].filter(path => path.includes(".sync-conflict-"));
    expect(copies.map(path => vault.text(path))).toEqual(["local only"]);
  });

  it.each(["read", "upload"])("rechecks selection after %s before sending the next request", async (phase) => {
    const { vault, fileRules, reconcile, push, uploadBlob, store } = setup();
    fileRules.includePdf = true;
    await vault.writeText("paper.pdf", "local");
    await reconcile();
    if (phase === "read") {
      const read = vault.readBytes.bind(vault);
      vi.spyOn(vault, "readBytes").mockImplementationOnce(async path => {
        fileRules.includePdf = false;
        return read(path);
      });
    } else {
      uploadBlob.mockImplementationOnce(async () => { fileRules.includePdf = false; });
    }
    const realtime = session(0);
    const send = vi.spyOn(realtime, "commitMutations");
    await expect(push(realtime)).rejects.toThrow("rules changed");
    expect(uploadBlob).toHaveBeenCalledTimes(phase === "read" ? 0 : 1);
    expect(send).not.toHaveBeenCalled();
    expect(await store.listDirtyEntries()).toHaveLength(1);
    await reconcile();
    expect(await store.listDirtyEntries()).toEqual([]);
    expect(vault.text("paper.pdf")).toBe("local");
  });

  it("keeps a pending upload when other file rules change before commit", async () => {
    const { vault, reconcile, push, uploadBlob, store, fileRules } = setup();
    await vault.writeText("note.md", "local edit");
    await reconcile();
    const pending = await store.listDirtyEntries();
    expect(pending).toHaveLength(1);
    let version = 0;
    uploadBlob.mockImplementationOnce(async () => {
      fileRules.includePdf = true;
      version++;
    });
    const realtime = session(0);
    const send = vi.spyOn(realtime, "commitMutations");
    await expect(push(realtime, () => version)).rejects.toThrow("rules changed");
    expect(uploadBlob).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(await store.listDirtyEntries()).toEqual(pending);
    expect(await store.getCursor()).toBe(0);
  });

  it("reads just the changed entry when 10,000 excluded files are already known", async () => {
    const { store, pull, commit, vault } = setup();
    await store.deferredFiles.put(Array.from({ length: 10_000 }, (_, i) =>
      ({ entryId: String(i), path: `Archive/${i}.md`, revision: 1 })));
    const service = pull(() => 1);
    expect(await service.hasNewlyIncludedFiles()).toBe(false);
    const list = vi.spyOn(store.deferredFiles, "list");
    const getMany = vi.spyOn(store.deferredFiles, "getMany");
    await service.pullOnce(session(1, [await commit("note.md", "note", 1, 1, "new")]));
    expect(vault.text("note.md")).toBe("new");
    expect(list).not.toHaveBeenCalled();
    expect(getMany.mock.calls).toEqual([[["note"]]]);
  });

  it("advances past excluded files without fetching their bodies, and restores only newly included files after restart", async () => {
    const { commit, pull, download, store, vault, fileRules } = setup();
    const pdf = await commit("report.PDF", "pdf", 1, 1, "pdf bytes");
    const archived = await commit("Archive/readme.md", "archive", 2, 1, "archived");
    const note = await commit("Notes/today.md", "note", 3, 1, "note");
    await pull().pullOnce(session(3, [pdf, archived, note]));
    expect(await store.getCursor()).toBe(3);
    expect(download.mock.calls.map(([, id]) => id)).toEqual(["note-1"]);
    expect(await pull().hasNewlyIncludedFiles()).toBe(false);
    fileRules.includePdf = true;
    expect(await pull().hasNewlyIncludedFiles()).toBe(true);
    const replay = session(3, [], [pdf]);
    const pages = vi.spyOn(replay, "listEntryStates");
    await pull().pullOnce(replay);
    expect(pages.mock.calls[0]?.[0].sinceCursor).toBe(3);
    expect(pages.mock.calls[1]?.[0].entryIds).toEqual(["pdf"]);
    expect(vault.text("report.PDF")).toBe("pdf bytes");
    expect(vault.text("Archive/readme.md")).toBeNull();
    expect(await store.deferredFiles.list()).toMatchObject([{ entryId: "archive" }]);
    fileRules.excludedFolders = [];
    await pull().pullOnce(session(3, [], [archived]));
    expect(vault.text("Archive/readme.md")).toBe("archived");
    expect(await store.deferredFiles.list()).toEqual([]);
    await pull().pullOnce(session(3, []));
    expect(download).toHaveBeenCalledTimes(3);
  });

  it.each(["edit", "delete"] as const)("protects a local edit across an excluded remote %s", async (operation) => {
    const { commit, pull, reconcile, download, store, vault, fileRules } = setup();
    fileRules.includePdf = true;
    const path = "report.pdf";
    await pull().pullOnce(session(1, [await commit(path, "pdf", 1, 1, "base")]));
    fileRules.includePdf = false;
    await vault.writeText(path, "local edit");
    const remote = await commit(path, "pdf", 2, 2, operation === "delete" ? null : "remote edit");
    await reconcile();
    await pull().pullOnce(session(2, [remote]));
    expect(await store.listDirtyEntries()).toEqual([]);
    expect(vault.text(path)).toBe("local edit");
    expect(download).toHaveBeenCalledTimes(1);
    fileRules.includePdf = true;
    await reconcile();
    expect(await store.getDirtyEntryMutation("pdf")).toMatchObject({ baseRevision: 1 });
    const result = await pull().pullOnce(session(2, [], [remote]));
    expect(result.conflictsCreated).toBe(1);
    expect(vault.text(path)).toBe(operation === "delete" ? null : "remote edit");
    expect([...vault.files.keys()].filter((p) => p.includes(".sync-conflict-")).map((p) => vault.text(p))).toEqual(["local edit"]);
    expect(await store.listDirtyEntries()).toEqual([]);
  });

  it.each(["upsert", "delete"] as const)("discards a queued %s on exclusion and rediscovers the local change on inclusion", async (op) => {
    const { commit, pull, push, reconcile, store, vault, fileRules, uploadBlob } = setup();
    const path = "report.pdf";
    fileRules.includePdf = true;
    await pull().pullOnce(session(1, [await commit(path, "pdf", 1, 1, "base")]));
    if (op === "delete") await vault.remove(path);
    else await vault.writeText(path, "edited");
    await reconcile();
    expect(await store.getDirtyEntryMutation("pdf")).toMatchObject({ op });
    fileRules.includePdf = false;
    expect(await push()).toMatchObject({ mutationsPushed: 0, hasMore: false });
    expect(uploadBlob).not.toHaveBeenCalled();
    await reconcile();
    expect(await store.listDirtyEntries()).toEqual([]);
    fileRules.includePdf = true;
    await reconcile();
    expect(await store.getDirtyEntryMutation("pdf")).toMatchObject({ op, baseRevision: 1 });
  });

  it("keeps a never-downloaded local namesake when first including a remote file", async () => {
    const { commit, pull, store, reconcile, vault, fileRules } = setup();
    const remote = await commit("new.pdf", "pdf", 1, 1, "remote");
    await pull().pullOnce(session(1, [remote]));
    await vault.writeText("new.pdf", "my file");
    fileRules.includePdf = true;
    await reconcile();
    await pull().pullOnce(session(1, [], [remote]));
    expect(vault.text("new.pdf")).toBe("remote");
    expect([...vault.files.keys()].filter((p) => p.includes(".sync-conflict-")).map((p) => vault.text(p))).toEqual(["my file"]);
    expect(await store.listDirtyEntries()).toEqual([]);
  });

  it("keeps the skipped revision through a failed download and rejects an older snapshot on retry", async () => {
    const { commit, pull, download, store, fileRules, vault } = setup();
    const newer = await commit("report.pdf", "pdf", 3, 3, "new");
    const older = await commit("report.pdf", "pdf", 2, 2, "stale");
    await pull().pullOnce(session(3, [newer]));
    fileRules.includePdf = true;
    download.mockRejectedValueOnce(new Error("offline"));
    await expect(pull().pullOnce(session(3, [], [newer]))).rejects.toThrow("offline");
    await pull().pullOnce(session(3, [], [older]));
    expect(vault.files.size).toBe(0);
    expect(await store.deferredFiles.list()).toMatchObject([{ revision: 3 }]);
    await pull().pullOnce(session(3, [], [newer]));
    expect(vault.text("report.pdf")).toBe("new");
  });

  it("parks edits to an included source until a remotely excluded entry comes back", async () => {
    const { commit, pull, push, reconcile, store, vault, uploadBlob } = setup();
    await pull().pullOnce(session(1, [await commit("a.md", "x", 1, 1, "base")]));
    await pull().pullOnce(session(2, [await commit("Archive/a.md", "x", 2, 2, "desktop")]));
    await vault.writeText("a.md", "phone-only edit");
    await reconcile();
    const pending = await store.getDirtyEntryMutation("x");
    expect(pending).toMatchObject({ baseRevision: 1 });
    expect(await push()).toMatchObject({ mutationsPushed: 0, hasMore: false });
    expect(uploadBlob).not.toHaveBeenCalled();
    expect(await store.getDirtyEntryMutation("x")).toEqual(pending);
    await pull().pullOnce(session(3, [await commit("b.md", "x", 3, 3, "desktop moved again")]));
    expect(vault.text("b.md")).toBe("desktop moved again");
    expect([...vault.files.keys()].filter((p) => p.includes(".sync-conflict-")).map((p) => vault.text(p))).toEqual(["phone-only edit"]);
  });

  it("applies a deferred tombstone and the new owner of its path in one snapshot", async () => {
    const { commit, pull, store, vault, fileRules } = setup();
    fileRules.includePdf = true;
    await pull().pullOnce(session(1, [await commit("paper.pdf", "x", 1, 1, "original")]));
    fileRules.includePdf = false;
    const deleted = await commit("paper.pdf", "x", 2, 2, null);
    await pull().pullOnce(session(2, [deleted]));
    fileRules.includePdf = true;
    const replacement = await commit("paper.pdf", "y", 3, 1, "replacement");
    const replay = session(3, [replacement], [deleted]);
    const pages = vi.spyOn(replay, "listEntryStates");
    expect(await pull().pullOnce(replay)).toMatchObject({ conflictsCreated: 0, cursor: 3 });
    expect(pages.mock.calls[1]?.[0]).toMatchObject({ entryIds: ["x"], targetCursor: 3 });
    expect([...vault.files.keys()]).toEqual(["paper.pdf"]);
    expect(vault.text("paper.pdf")).toBe("replacement");
    expect(await store.getEntryByPath("paper.pdf")).toMatchObject({ entryId: "y" });
  });

  it.each(["unchanged", "queued", "watcher pending"])("hands a vacated included path to its new owner (%s)", async (edit) => {
    const { commit, pull, store, vault, fileRules, reconcile } = setup();
    let version = 1;
    const service = pull(() => version);
    await service.pullOnce(session(1, [await commit("a.md", "x", 1, 1, "base")]));
    const moved = await commit("Archive/a.md", "x", 2, 2, "moved");
    await service.pullOnce(session(2, [moved]));
    if (edit !== "unchanged") {
      await vault.writeText("a.md", "local edit");
      if (edit === "queued") await reconcile();
    }
    await service.pullOnce(session(3, [await commit("a.md", "y", 3, 1, "replacement")]));
    expect(vault.text("a.md")).toBe("replacement");
    expect(await store.getEntryByPath("a.md")).toMatchObject({ entryId: "y" });
    fileRules.excludedFolders = [];
    version++;
    await service.pullOnce(session(3, [], [moved]));
    expect(vault.text("Archive/a.md")).toBe("moved");
    expect(vault.text("a.md")).toBe("replacement");
    expect([...vault.files.keys()].filter((p) => p.includes(".sync-conflict-")).map((p) => vault.text(p))).toEqual(edit === "unchanged" ? [] : ["local edit"]);
  });

  it("preserves edits to both files when a remote rename replaces a deferred owner", async () => {
    const { commit, pull, vault, reconcile } = setup();
    await pull().pullOnce(session(2, [
      await commit("a.md", "x", 1, 1, "a"), await commit("b.md", "y", 2, 1, "b"),
    ]));
    await pull().pullOnce(session(3, [await commit("Archive/a.md", "x", 3, 2, "archived")]));
    await vault.writeText("a.md", "phone edit A");
    await vault.writeText("b.md", "phone edit B");
    await reconcile();
    const result = await pull().pullOnce(session(4, [await commit("a.md", "y", 4, 2, "replacement")]));
    expect(vault.text("a.md")).toBe("replacement");
    expect(result.conflictsCreated).toBe(2);
    const copies = [...vault.files.keys()].filter((p) => p.includes(".sync-conflict-"));
    expect(copies.map((p) => vault.text(p)).sort()).toEqual(["phone edit A", "phone edit B"]);
  });

  it("rejects a changed recovery target before touching the vault or checkpoint", async () => {
    const { commit, pull, store, vault, fileRules } = setup();
    const pdf = await commit("paper.pdf", "x", 1, 1, "v1");
    await pull().pullOnce(session(1, [pdf]));
    fileRules.includePdf = true;
    const newer = await commit("paper.pdf", "x", 2, 2, "v2");
    const replay = createRealtimeSession({ pages: [
      { cursor: 1, commits: [], hasMore: false }, { cursor: 2, commits: [newer], hasMore: false },
    ] });
    await expect(pull().pullOnce(replay)).rejects.toThrow("changed its target cursor");
    expect(await store.getCursor()).toBe(1);
    expect(vault.text("paper.pdf")).toBeNull();
    expect(await store.deferredFiles.get("x")).toMatchObject({ revision: 1 });
  });

  it("rechecks the rules before writing a PDF whose download was already in flight", async () => {
    const { commit, pull, store, vault, fileRules, download } = setup();
    fileRules.includePdf = true;
    let version = 1;
    const service = pull(() => version);
    const pdf = await commit("paper.pdf", "x", 1, 1, "remote");
    download.mockImplementationOnce(async (_vaultId, blobId) => {
      fileRules.includePdf = false;
      version++;
      return encryptTestBlob(blobId, new TextEncoder().encode("remote"));
    });
    await expect(service.pullOnce(session(1, [pdf]))).rejects.toThrow("rules changed");
    expect(vault.text("paper.pdf")).toBeNull();
    expect(await store.getCursor()).toBe(0);
    await service.pullOnce(session(1, [pdf]));
    expect(download).toHaveBeenCalledTimes(1);
    expect(await store.deferredFiles.get("x")).toMatchObject({ revision: 1 });
  });

  it("does not reread excluded markers on empty polls until the rules change", async () => {
    const { commit, pull, store, fileRules } = setup();
    const list = vi.spyOn(store.deferredFiles, "list");
    let version = 1;
    const service = pull(() => version);
    const pdf = await commit("paper.pdf", "x", 1, 1, "doc");
    await service.pullOnce(session(1, [pdf]));
    await service.pullOnce(session(1, []));
    expect(await service.hasNewlyIncludedFiles()).toBe(false);
    expect(list).toHaveBeenCalledTimes(1);
    fileRules.includePdf = true;
    version++;
    expect(await service.hasNewlyIncludedFiles()).toBe(true);
    await service.pullOnce(session(1, [], [pdf]));
    expect(await store.deferredFiles.list()).toEqual([]);
  });

  it("keeps the excluded source on a remote rename into an included folder", async () => {
    const { commit, pull, vault, fileRules } = setup();
    fileRules.excludedFolders = [];
    await pull().pullOnce(session(1, [await commit("Archive/a.md", "a", 1, 1, "original")]));
    fileRules.excludedFolders = ["Archive"];
    await vault.writeText("Archive/a.md", "private edit");
    await pull().pullOnce(session(2, [await commit("a.md", "a", 2, 2, "remote")]));
    expect(vault.text("a.md")).toBe("remote");
    expect(vault.text("Archive/a.md")).toBe("private edit");
    expect(vault.renames).toEqual([]);
  });
});
