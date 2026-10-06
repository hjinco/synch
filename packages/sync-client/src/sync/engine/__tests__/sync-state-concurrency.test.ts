import { describe, expect, it, vi } from "vitest";
import { createTestContentRuntime } from "../../../test-support/content-runtime";
import { createTestSyncStore } from "../../../test-support/in-memory-sync-store";
import { decryptSyncMetadata } from "../../core/crypto";
import { SyncEventRecorder } from "../event-recorder";
import { SyncPullService } from "../pull-service";
import { SyncPushService } from "../push-service";
import { SyncLocalReconcileService } from "../local-reconcile-service";
import {
  createBlobClient, createCommit, createRealtimeSession, createToken, createVaultAdapter,
  encryptRemoteMetadata, encryptTestBlob, hashText, TEST_VAULT_KEY,
} from "./pull-service/helpers";
import { createPushSession } from "./push-service/helpers";

const encode = (value: string) => new TextEncoder().encode(value);
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const base = "Title\n\noriginal line\n";
  const local = "Title\n\nlocal line\n";
  const remote = "Remote title\n\noriginal line\n";
  const store = createTestSyncStore();
  const adapter = createVaultAdapter({ "note.md": base });
  const contentRuntime = createTestContentRuntime();
  const deps = { contentRuntime, getSyncStore: () => store, getRemoteVaultKey: () => TEST_VAULT_KEY };
  await store.upsertEntry({
    entryId: "note", path: "note.md", revision: 2, blobId: "base", hash: await hashText(base),
    deleted: false, updatedAt: 1, localMtime: null, localSize: null,
  });
  await store.putBlob({
    blobId: "base", hash: await hashText(base), encryptedBytes: await encryptTestBlob("base", encode(base)),
    role: "remote", refEntryId: "note", cachedAt: 1,
  });
  const commit = createCommit({
    cursor: 90, entryId: "note", revision: 3, blobId: "remote",
    encryptedMetadata: await encryptRemoteMetadata({
      entryId: "note", revision: 3, blobId: "remote", path: "note.md", hash: await hashText(remote),
    }),
  });
  const blobClient = createBlobClient({ blobs: { remote: await encryptTestBlob("remote", encode(remote)) } });
  const pull = new SyncPullService({ ...deps, getSyncToken: async () => createToken(), vaultAdapter: adapter, blobClient });
  const recorder = new SyncEventRecorder(deps);
  const session = () => createRealtimeSession({ pages: [{ cursor: 90, hasMore: false, commits: [commit] }] });
  return { store, adapter, deps, blobClient, pull, recorder, session, commit, base, local, remote };
}

async function expectMerged(test: Awaited<ReturnType<typeof fixture>>, body = "Remote title\n\nlocal line\n") {
  expect(test.adapter.text("note.md")).toBe(body);
  expect((await test.store.getRemoteStateById("note"))?.revision).toBe(3);
  const pending = await test.store.getDirtyEntryMutation("note");
  expect(pending).toMatchObject({ baseRevision: 3, hash: await hashText(body) });
  expect(await decryptSyncMetadata(TEST_VAULT_KEY, pending!.encryptedMetadata, {
    entryId: "note", revision: 4, op: "upsert", blobId: pending!.blobId,
  })).toEqual({ path: "note.md", hash: await hashText(body) });
}

describe("local edits overlapping remote sync", () => {
  it("does not persist base 2 after pull applies revision 3 while a local mutation is being built", async () => {
    const test = await fixture();
    test.adapter.files.set("note.md", encode(test.local));
    const saving = gate();
    const release = gate();
    const replace = test.store.replaceDirtyEntry.bind(test.store);
    vi.spyOn(test.store, "replaceDirtyEntry").mockImplementationOnce(async (...args) => {
      expect(args[0].baseRevision).toBe(2);
      saving.resolve();
      await release.promise;
      await replace(...args);
    });
    const edit = test.recorder.recordUpsert("note.md", encode(test.local));
    await saving.promise;
    const read = vi.spyOn(test.adapter, "readBytes");
    const pull = test.pull.pullOnce(test.session());
    try {
      await vi.waitFor(() => expect(read).toHaveBeenCalled());
      // A separate file still proceeds while note.md's state is occupied.
      await test.recorder.recordUpsert("other.txt", encode("independent"));
      expect((await test.store.getRemoteStateById("note"))?.revision).toBe(2);
    } finally { release.resolve(); }
    await Promise.all([edit, pull]);
    await expectMerged(test);
    expect(await test.store.getCursor()).toBe(90);
  });

  it("replans a download when a local edit arrives, without holding the entry during network I/O", async () => {
    const test = await fixture();
    const downloading = gate();
    const release = gate();
    const download = test.blobClient.downloadBlob.bind(test.blobClient);
    vi.spyOn(test.blobClient, "downloadBlob").mockImplementationOnce(async (...args) => {
      downloading.resolve();
      await release.promise;
      return await download(...args);
    });
    const pull = test.pull.pullOnce(test.session());
    await downloading.promise;
    try {
      test.adapter.files.set("note.md", encode(test.local));
      await test.recorder.recordUpsertFromFile("note.md", async () => await test.adapter.readBytes("note.md"));
      expect((await test.store.getDirtyEntryMutation("note"))?.baseRevision).toBe(2);
    } finally { release.resolve(); }
    await pull;
    await expectMerged(test);
  });

  it("preserves edits made during download even before the filesystem event is recorded", async () => {
    const test = await fixture();
    const download = test.blobClient.downloadBlob.bind(test.blobClient);
    vi.spyOn(test.blobClient, "downloadBlob").mockImplementationOnce(async (...args) => {
      test.adapter.files.set("note.md", encode(test.local));
      return await download(...args);
    });
    await test.pull.pullOnce(test.session());
    await expectMerged(test);
  });

  it("preserves a newly created local file at a path being downloaded for the first time", async () => {
    const test = await fixture();
    await test.store.deleteEntry("note");
    test.adapter.files.delete("note.md");
    const download = test.blobClient.downloadBlob.bind(test.blobClient);
    vi.spyOn(test.blobClient, "downloadBlob").mockImplementationOnce(async (...args) => {
      test.adapter.files.set("note.md", encode(test.local));
      return await download(...args);
    });
    await test.pull.pullOnce(test.session());
    expect(test.adapter.text("note.md")).toBe(test.remote);
    const copy = [...test.adapter.files.keys()].find((path) => path.includes("sync-conflict"));
    expect(copy).toBeDefined();
    expect(test.adapter.text(copy!)).toBe(test.local);
  });

  it("rebuilds a reconciliation snapshot after a pull and keeps the merged bytes", async () => {
    const test = await fixture();
    test.adapter.files.set("note.md", encode(test.local));
    await test.recorder.recordUpsert("note.md", encode(test.local));
    const reading = gate();
    const release = gate();
    let reads = 0;
    const reconcile = new SyncLocalReconcileService({
      ...test.deps, shouldSyncPath: () => true,
      scanner: { async listFiles() { return [{
        path: "note.md", mtime: 10, size: test.adapter.bytes("note.md")!.length,
        async readBytes() {
          const bytes = await test.adapter.readBytes("note.md");
          if (reads++ === 0) { reading.resolve(); await release.promise; }
          return bytes;
        },
      }]; } },
    });
    const scan = reconcile.reconcileOnce();
    await reading.promise;
    try { await test.pull.pullOnce(test.session()); }
    finally { release.resolve(); }
    await scan;
    await expectMerged(test);
  });

  it("rebases a newer edit when an earlier push acknowledgement arrives", async () => {
    const test = await fixture();
    test.adapter.files.set("note.md", encode(test.local));
    await test.recorder.recordUpsert("note.md", encode(test.local));
    const sent = gate();
    const release = gate();
    const session = createPushSession(async (mutation) => {
      sent.resolve();
      await release.promise;
      return { cursor: 90, entryId: mutation.entryId, revision: 3 };
    });
    const push = new SyncPushService({
      ...test.deps, getSyncToken: async () => createToken(), fileReader: test.adapter,
      blobClient: { async uploadBlob() {} },
    });
    let yieldPush = false;
    const pushing = push.pushPendingMutations(session, undefined, () => yieldPush);
    await sent.promise;
    const newer = "Title\n\nnewest local line\n";
    try {
      test.adapter.files.set("note.md", encode(newer));
      await test.recorder.recordUpsert("note.md", encode(newer));
      yieldPush = true;
    } finally { release.resolve(); }
    await pushing;
    const pending = await test.store.getDirtyEntryMutation("note");
    expect(pending).toMatchObject({ baseRevision: 3, hash: await hashText(newer) });
    expect(test.adapter.text("note.md")).toBe(newer);
    await expect(decryptSyncMetadata(TEST_VAULT_KEY, pending!.encryptedMetadata, {
      entryId: "note", revision: 4, op: "upsert", blobId: pending!.blobId,
    })).resolves.toEqual({ path: "note.md", hash: await hashText(newer) });
  });
  it("orders rename and delete even when the destination has no owner yet", async () => {
    const test = await fixture();
    const saving = gate();
    const release = gate();
    const replace = test.store.replaceDirtyEntry.bind(test.store);
    vi.spyOn(test.store, "replaceDirtyEntry").mockImplementationOnce(async (...args) => {
      saving.resolve();
      await release.promise;
      await replace(...args);
    });
    const rename = test.recorder.recordRename("note.md", "renamed.md", encode(test.base));
    await saving.promise;
    const deletion = test.recorder.recordDelete("renamed.md");
    release.resolve();
    await Promise.all([rename, deletion]);
    expect(await test.store.getLocalStateById("note")).toMatchObject({ path: null, deleted: true });
    expect(await test.store.listDirtyEntries()).toMatchObject([{ entryId: "note", op: "delete", baseRevision: 2 }]);
    const pending = (await test.store.getDirtyEntryMutation("note"))!;
    await expect(decryptSyncMetadata(TEST_VAULT_KEY, pending.encryptedMetadata, {
      entryId: "note", revision: 3, op: "delete", blobId: null,
    })).resolves.toEqual({ path: "renamed.md", hash: null });
  });

  it("bounds replanning during continuous filesystem edits and leaves the cursor unchanged", async () => {
    const test = await fixture();
    let edits = 0;
    const download = test.blobClient.downloadBlob.bind(test.blobClient);
    vi.spyOn(test.blobClient, "downloadBlob").mockImplementation(async (...args) => {
      test.adapter.files.set("note.md", encode(`Title\n\nlocal edit ${++edits}\n`));
      return await download(...args);
    });
    await expect(test.pull.pullOnce(test.session())).rejects.toMatchObject({ code: "local_sync_state_changed" });
    expect(edits).toBe(3);
    expect(test.adapter.writes).toEqual([]);
    expect(await test.store.getCursor()).toBe(0);
    expect((await test.store.getDirtyEntryMutation("note"))?.hash).toBe(await hashText("Title\n\nlocal edit 3\n"));
    expect((await test.store.getRemoteStateById("note"))?.revision).toBe(2);
  });

  it("does not replay a completed group or consume its newer edit when another group replans", async () => {
    const test = await fixture();
    const firstCommit = createCommit({
      cursor: 89, entryId: "a", revision: 1, blobId: "first",
      encryptedMetadata: await encryptRemoteMetadata({
        entryId: "a", revision: 1, blobId: "first", path: "a.txt", hash: await hashText("first remote"),
      }),
    });
    const firstBlob = await encryptTestBlob("first", encode("first remote"));
    const download = test.blobClient.downloadBlob.bind(test.blobClient);
    let edited = false;
    vi.spyOn(test.blobClient, "downloadBlob").mockImplementation(async (vaultId, blobId) => {
      if (blobId === "first") return firstBlob;
      if (!edited) {
        edited = true;
        test.adapter.files.set("a.txt", encode("new local a"));
        await test.recorder.recordUpsert("a.txt", encode("new local a"));
        test.adapter.files.set("note.md", encode(test.local));
        await test.recorder.recordUpsert("note.md", encode(test.local));
      }
      return await download(vaultId, blobId);
    });
    const service = new SyncPullService({
      ...test.deps, getSyncToken: async () => createToken(), vaultAdapter: test.adapter,
      blobClient: test.blobClient, prepareConcurrency: 1,
    });
    const result = await service.pullOnce(createRealtimeSession({ pages: [{
      cursor: 90, hasMore: false, commits: [firstCommit, test.commit],
    }] }));
    expect(result).toMatchObject({ entriesApplied: 2, filesWritten: 2 });
    expect(test.adapter.writes.filter((path) => path === "a.txt")).toHaveLength(1);
    expect(test.adapter.text("a.txt")).toBe("new local a");
    expect(await test.store.getDirtyEntryMutation("a")).toMatchObject({ baseRevision: 1, hash: await hashText("new local a") });
    await expectMerged(test);
  });

});
