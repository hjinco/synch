import { decodeBase64 } from "@synch/vault-crypto";
import { describe, expect, it, vi } from "vitest";
import { createTestContentRuntime } from "../../../test-support/content-runtime";
import { createTestSyncStore } from "../../../test-support/in-memory-sync-store";
import { decryptSyncBlob, decryptSyncMetadata } from "../../core/crypto";
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

async function fixture(remote = "Remote title\n\noriginal line\n", path = "note.md") {
  const base = "Title\n\noriginal line\n";
  const local = "Title\n\nlocal line\n";
  const store = createTestSyncStore();
  const adapter = createVaultAdapter({ [path]: base });
  const contentRuntime = createTestContentRuntime();
  const deps = { contentRuntime, getSyncStore: () => store, getRemoteVaultKey: () => TEST_VAULT_KEY };
  await store.upsertEntry({
    entryId: "note", path, revision: 2, blobId: "base", hash: await hashText(base),
    deleted: false, updatedAt: 1, localMtime: null, localSize: null,
  });
  await store.putBlob({
    blobId: "base", hash: await hashText(base), encryptedBytes: await encryptTestBlob("base", encode(base)),
    role: "remote", refEntryId: "note", cachedAt: 1,
  });
  const commit = createCommit({
    cursor: 90, entryId: "note", revision: 3, blobId: "remote",
    encryptedMetadata: await encryptRemoteMetadata({
      entryId: "note", revision: 3, blobId: "remote", path, hash: await hashText(remote),
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

function caseInsensitive(adapter: ReturnType<typeof createVaultAdapter>) {
  const disk = (path: string) => path.toLowerCase();
  return {
    ...adapter,
    statKind: (path: string) => adapter.statKind(disk(path)),
    exists: (path: string) => adapter.exists(disk(path)),
    readBytes: (path: string) => adapter.readBytes(disk(path)),
    getFileSize: (path: string) => adapter.getFileSize(disk(path)),
    writeText: (path: string, body: string) => adapter.writeText(disk(path), body),
    remove: (path: string) => adapter.remove(disk(path)),
    rename: (from: string, to: string) => adapter.rename(disk(from), disk(to)),
    areSameFilePaths: async (from: string, to: string) => disk(from) === disk(to),
  };
}

describe("local edits overlapping remote sync", () => {
  it("keeps a remote case-only rename on a case-insensitive vault", async () => {
    const { adapter, deps, base, store } = await fixture();
    const aliasAdapter = caseInsensitive(adapter);
    const service = new SyncPullService({
      ...deps, getSyncToken: async () => createToken(), vaultAdapter: aliasAdapter,
      blobClient: createBlobClient({ blobs: { base: await encryptTestBlob("base", encode(base)) } }),
    });
    const commit = createCommit({
      entryId: "note", cursor: 90, revision: 3, blobId: "base",
      encryptedMetadata: await encryptRemoteMetadata({
        entryId: "note", revision: 3, blobId: "base", path: "Note.md", hash: await hashText(base),
      }),
    });
    const result = await service.pullOnce(createRealtimeSession({
      pages: [{ cursor: 90, hasMore: false, commits: [commit] }],
    }));
    expect(result).toMatchObject({ filesDeleted: 0, conflictsCreated: 0 });
    expect(adapter.text("note.md")).toBe(base);
    expect(await store.getEntryById("note")).toMatchObject({ path: "Note.md", revision: 3 });
    expect(await store.listDirtyEntries()).toEqual([]);
  });

  it("recovers the physical spelling in a shared directory after an interrupted download", async () => {
    const source = "folder/note.md";
    const destination = "Folder/note.md";
    const { adapter, deps, store, blobClient, remote } = await fixture(undefined, source);
    adapter.files.set("folder/sibling.md", encode("sibling"));
    const vault = caseInsensitive(adapter);
    const options = { ...deps, getSyncToken: async () => createToken(), vaultAdapter: vault, blobClient };
    const commit = createCommit({
      entryId: "note", cursor: 90, revision: 3, blobId: "remote",
      encryptedMetadata: await encryptRemoteMetadata({
        entryId: "note", revision: 3, blobId: "remote", path: destination, hash: await hashText(remote),
      }),
    });
    vi.spyOn(vault, "writeText").mockImplementationOnce(async (path, body) => {
      await adapter.writeText(path.toLowerCase(), body);
      throw new Error("interrupted after write");
    });
    const session = createRealtimeSession({ pages: [{ cursor: 90, hasMore: false, commits: [commit] }] });
    await expect(new SyncPullService(options).pullOnce(session)).rejects.toThrow("interrupted after write");
    expect(await store.textMerges.listEntryIds()).toEqual(["note"]);
    await new SyncPullService(options).recoverPendingWrites();
    expect(await store.getLocalStateById("note")).toMatchObject({ path: source, hash: await hashText(remote) });
    expect(await store.getRemoteStateById("note")).toMatchObject({ path: destination, revision: 3 });
    expect(await store.listDirtyEntries()).toEqual([]);
    expect(await store.textMerges.listEntryIds()).toEqual([]);
  });

  it.each([{ count: 6, concurrency: 1 }, { count: 40, concurrency: 10 }])(
    "replans a window of $count unobserved edits at concurrency $concurrency", async ({ count, concurrency }) => {
    const { deps, adapter, store } = await fixture();
    const blobs: Record<string, Uint8Array> = {};
    const commits = [];
    for (let index = 1; index <= count; index++) {
      const entryId = String(index);
      const path = entryId + ".txt";
      const blobId = "remote-" + entryId;
      await store.upsertEntry({ entryId, path, revision: 1, blobId: "base-" + entryId,
        hash: await hashText("base"), deleted: false, updatedAt: 1 });
      adapter.files.set(path, encode("local " + entryId));
      blobs[blobId] = await encryptTestBlob(blobId, encode("remote " + entryId));
      commits.push(createCommit({ entryId, cursor: index, revision: 2, blobId,
        encryptedMetadata: await encryptRemoteMetadata({
          entryId, path, revision: 2, blobId, hash: await hashText("remote " + entryId),
        }),
      }));
    }
    const service = new SyncPullService({ ...deps, getSyncToken: async () => createToken(),
      vaultAdapter: adapter, blobClient: createBlobClient({ blobs }), prepareConcurrency: concurrency });
    const session = createRealtimeSession({ pages: [{ cursor: count, hasMore: false, commits }] });
    const result = await service.pullOnce(session);
    expect(result).toMatchObject({ entriesApplied: count, conflictsCreated: count });
    expect(await store.getCursor()).toBe(count);
    expect(await store.listDirtyEntries()).toEqual([]);
    const copies = [...adapter.files.keys()].filter((path) => path.includes(".sync-conflict-"));
    for (let index = 1; index <= count; index++) {
      expect(adapter.text(index + ".txt")).toBe("remote " + index);
      expect(copies.map((path) => adapter.text(path))).toContain("local " + index);
    }
  });

  it("merges a local edit already on disk before pull starts and writes only the final bytes", async () => {
    const test = await fixture();
    test.adapter.files.set("note.md", encode(test.local));
    const write = vi.spyOn(test.adapter, "writeText");
    await test.pull.pullOnce(test.session());
    await expectMerged(test);
    expect(write.mock.calls).toEqual([["note.md", "Remote title\n\nlocal line\n"]]);
  });

  it.each(["rename", "delete"] as const)("protects an unrecorded edit before a remote %s", async (op) => {
    const test = await fixture();
    const deleted = op === "delete";
    const path = deleted ? "note.md" : "moved.md";
    const blobId = deleted ? null : "remote";
    const commit = createCommit({
      cursor: 90, entryId: "note", revision: 3, op: deleted ? "delete" : "upsert", blobId,
      encryptedMetadata: await encryptRemoteMetadata({
        entryId: "note", revision: 3, path, blobId, deleted, hash: await hashText(test.remote),
      }),
    });
    test.adapter.files.set("note.md", encode(test.local));
    await test.pull.pullOnce(createRealtimeSession({pages: [{cursor: 90, hasMore: false, commits: [commit]}]}));
    const copies = [...test.adapter.files.keys()].filter((name) => name.includes(".sync-conflict-"));
    expect(copies.map((name) => test.adapter.text(name))).toEqual([test.local]);
    expect(test.adapter.text("note.md")).toBeNull();
    if (!deleted) expect(test.adapter.text(path)).toBe(test.remote);
    expect(await test.store.getCursor()).toBe(90);
  });

  it.each(["before write", "after write", "during DB commit", "after commit", "watcher after write", "edited after write"] as const)(
    "recovers an interrupted merge (%s) and uploads it once", async (phase) => {
      const test = await fixture();
      test.adapter.files.set("note.md", encode(test.local));
      await test.recorder.recordUpsert("note.md", encode(test.local));
      const failure = new Error("interrupted merge");
      if (phase === "before write") vi.spyOn(test.adapter, "writeText").mockRejectedValueOnce(failure);
      else if (phase === "during DB commit") {
        vi.spyOn(test.store, "applyLocalState").mockRejectedValueOnce(failure);
        // Leave the partially committed rows intact, as on process termination.
        vi.spyOn(test.store, "clearRemoteState").mockRejectedValueOnce(failure);
      } else if (phase === "after commit") vi.spyOn(test.store.textMerges, "remove").mockRejectedValueOnce(failure);
      else vi.spyOn(test.store, "replaceDirtyEntry").mockRejectedValueOnce(failure);
      await expect(test.pull.pullOnce(test.session())).rejects.toThrow(failure);
      const intent = await test.store.textMerges.get("note");
      if (intent?.kind === "download") throw new Error("Expected a text merge");
      expect(intent?.sourceHash).toBe(await hashText(test.local));
      const merged = "Remote title\n\nlocal line\n";
      expect(test.adapter.text("note.md")).toBe(phase === "before write" ? test.local : merged);

      const expected = phase === "edited after write" ? merged + "later edit\n" : merged;
      if (phase === "edited after write") test.adapter.files.set("note.md", encode(expected));
      if (phase === "watcher after write") await test.recorder.recordUpsert("note.md", encode(merged));
      const restarted = new SyncPullService({
        ...test.deps, getSyncToken: async () => createToken(), vaultAdapter: test.adapter, blobClient: test.blobClient,
      });
      await restarted.pullOnce(test.session());
      await expectMerged(test, expected);
      expect(await test.store.textMerges.listEntryIds()).toEqual([]);
      if (phase !== "before write" && phase !== "edited after write") {
        expect((await test.store.getDirtyEntryMutation("note"))?.mutationId).toBe(intent?.mutation.mutationId);
        expect(test.adapter.writes).toEqual(["note.md"]);
      }

      const push = new SyncPushService({
        ...test.deps, getSyncToken: async () => createToken(), fileReader: test.adapter,
        blobClient: { async uploadBlob() {} },
      });
      const session = createPushSession(async ({ entryId, baseRevision }) => {
        expect(baseRevision).toBe(3);
        return { cursor: 91, entryId, revision: 4 };
      });
      expect((await push.pushPendingMutations(session)).mutationsPushed).toBe(1);
      expect((await push.pushPendingMutations(session)).mutationsPushed).toBe(0);
    },
  );

  it.each([0, 2, 8])("repairs a write truncated at byte %s and preserves the ambiguous prefix", async (length) => {
    const test = await fixture("원격 제목\n\noriginal line\n");
    test.adapter.files.set("note.md", encode(test.local));
    await test.recorder.recordUpsert("note.md", encode(test.local));
    const merged = "원격 제목\n\nlocal line\n";
    const partial = encode(merged).slice(0, length);
    vi.spyOn(test.adapter, "writeText").mockImplementationOnce(async (path) => {
      test.adapter.files.set(path, partial);
      throw new Error("interrupted write");
    });
    await expect(test.pull.pullOnce(test.session())).rejects.toThrow("interrupted write");

    const intent = (await test.store.textMerges.get("note"))!;
    if (intent.kind === "download") throw new Error("Expected a text merge");
    const staged = intent.staged!;
    expect(new TextDecoder().decode(await decryptSyncBlob(TEST_VAULT_KEY,
      decodeBase64(staged.sourceCiphertext), { blobId: staged.sourceBlobId }))).toBe(test.local);
    expect(new TextDecoder().decode(await decryptSyncBlob(TEST_VAULT_KEY,
      decodeBase64(staged.mergedCiphertext), { blobId: intent.mutation.blobId }))).toBe(merged);
    expect(JSON.stringify(intent)).not.toContain("local line");

    // A second failure after the recovery copy is written must reuse it.
    vi.spyOn(test.adapter, "writeText").mockRejectedValueOnce(new Error("retry write"));
    await expect(test.pull.pullOnce(test.session())).rejects.toThrow("retry write");
    await test.pull.pullOnce(test.session());
    await expectMerged(test, merged);
    const copies = [...test.adapter.files.keys()].filter((path) => path.includes("sync-conflict"));
    expect(copies.map((path) => test.adapter.bytes(path))).toEqual([partial]);
    expect(await test.store.textMerges.listEntryIds()).toEqual([]);
  });

  it.each(["prefer-remote", "conflict-copy"] as const)(
    "preserves a concurrent byte change when the host cannot compare the source (%s)", async (policy) => {
      const test = await fixture();
      const local = "Title\n\nlocal \uFFFD line\n";
      const merged = "Remote title\n\nlocal \uFFFD line\n";
      test.adapter.files.set("note.md", encode(local));
      await test.recorder.recordUpsert("note.md", encode(local));
      const malformed = Uint8Array.from([...encode("Title\n\nlocal "), 255, ...encode(" line\n")]);
      const write = test.adapter.writeBinary.bind(test.adapter);
      vi.spyOn(test.adapter, "writeBinary").mockImplementationOnce(async (path, bytes) => {
        test.adapter.files.set("note.md", malformed);
        await write(path, bytes);
      });
      const pull = new SyncPullService({
        ...test.deps, getSyncToken: async () => createToken(), blobClient: test.blobClient,
        getConflictPolicy: () => policy,
        vaultAdapter: { ...test.adapter, canCompareTextForWrite: () => false },
      });
      const result = await pull.pullOnce(test.session());
      expect(result).toMatchObject({ cursor: 90, filesWritten: 0, conflictsCreated: 1 });
      expect(test.adapter.bytes("note.md")).toEqual(malformed);
      const copies = [...test.adapter.files.keys()].filter((path) => path.includes("sync-conflict"));
      expect(copies.map((path) => test.adapter.text(path))).toEqual([merged]);
      const pending = await test.store.getDirtyEntryMutation("note");
      expect(pending).toMatchObject({ baseRevision: 3, hash: await test.deps.contentRuntime.hash(malformed.slice()) });
      await pull.pullOnce(test.session());
      expect(await test.store.getDirtyEntryMutation("note")).toEqual(pending);
      expect(test.adapter.files.size).toBe(2);
    },
  );

  it("preserves a partial UTF-8 character when a text-only host cannot safely repair it", async () => {
    const test = await fixture("원격 제목\n\noriginal line\n");
    test.adapter.files.set("note.md", encode(test.local));
    await test.recorder.recordUpsert("note.md", encode(test.local));
    const merged = "원격 제목\n\nlocal line\n";
    const partial = encode(merged).slice(0, 1);
    vi.spyOn(test.adapter, "writeText").mockImplementationOnce(async (path) => {
      test.adapter.files.set(path, partial);
      throw new Error("interrupted write");
    });
    await expect(test.pull.pullOnce(test.session())).rejects.toThrow("interrupted write");
    const restarted = new SyncPullService({
      ...test.deps, getSyncToken: async () => createToken(), blobClient: test.blobClient,
      vaultAdapter: { ...test.adapter, canCompareTextForWrite: () => false },
    });
    await restarted.pullOnce(test.session());
    expect(test.adapter.bytes("note.md")).toEqual(partial);
    const copies = [...test.adapter.files.keys()].filter((path) => path.includes("sync-conflict"));
    expect(copies.map((path) => test.adapter.text(path))).toEqual([merged]);
    expect(await test.store.getDirtyEntryMutation("note")).toMatchObject({
      baseRevision: 3, hash: await test.deps.contentRuntime.hash(partial.slice()),
    });
    expect(await test.store.textMerges.listEntryIds()).toEqual([]);
  });

  it("finishes a preserved-source merge after a save takes the conflict path and the DB commit fails", async () => {
    const test = await fixture();
    const local = "Title\n\nlocal \uFFFD\n";
    const merged = "Remote title\n\nlocal \uFFFD\n";
    test.adapter.files.set("note.md", encode(local));
    await test.recorder.recordUpsert("note.md", encode(local));
    const malformed = Uint8Array.of(255);
    let raced = false;
    const service = () => new SyncPullService({
      ...test.deps, getSyncToken: async () => createToken(), blobClient: test.blobClient,
      getConflictPolicy: () => "prefer-remote",
      vaultAdapter: {
        ...test.adapter, canCompareTextForWrite: () => false,
        async writeBytesIfAbsent(path, bytes) {
          if (!raced) {
            raced = true;
            test.adapter.files.set(path, encode("other note"));
            test.adapter.files.set("note.md", malformed);
            return false;
          }
          if (await test.adapter.exists(path)) return false;
          await test.adapter.writeBinary(path, bytes);
          return true;
        },
      },
    });
    vi.spyOn(test.store, "applyReconcileEntryUpdates").mockRejectedValueOnce(new Error("interrupted commit"));
    await expect(service().pullOnce(test.session())).rejects.toThrow("interrupted commit");
    await service().pullOnce(test.session());
    expect(test.adapter.bytes("note.md")).toEqual(malformed);
    const copies = [...test.adapter.files.keys()].filter((path) => path.includes("sync-conflict"));
    expect(copies.map((path) => test.adapter.text(path))).toEqual(["other note", merged]);
    expect(await test.store.getDirtyEntryMutation("note")).toMatchObject({
      baseRevision: 3, hash: await test.deps.contentRuntime.hash(malformed.slice()),
    });
    expect(await test.store.textMerges.listEntryIds()).toEqual([]);
  });

  it("keeps both versions when a new edit arrived before install was confirmed", async () => {
    const test = await fixture();
    test.adapter.files.set("note.md", encode(test.local));
    await test.recorder.recordUpsert("note.md", encode(test.local));
    const latest = "Replaced with a different text";
    vi.spyOn(test.adapter, "writeText").mockImplementationOnce(async (path) => {
      test.adapter.files.set(path, encode(latest));
      throw new Error("unknown install status");
    });
    await expect(test.pull.pullOnce(test.session())).rejects.toThrow("unknown install status");
    vi.spyOn(test.store.textMerges, "remove").mockRejectedValueOnce(new Error("cleanup interrupted"));
    await expect(test.pull.pullOnce(test.session())).rejects.toThrow("cleanup interrupted");
    const first = await test.store.getDirtyEntryMutation("note");
    await test.pull.pullOnce(test.session());
    await expectMerged(test, latest);
    expect(await test.store.getDirtyEntryMutation("note")).toEqual(first);
    const copies = [...test.adapter.files.keys()].filter((path) => path.includes("sync-conflict"));
    expect(copies.map((path) => test.adapter.text(path))).toEqual(["Remote title\n\nlocal line\n"]);
  });

  it("keeps the merged copy in a surviving directory when its parent was replaced by a file", async () => {
    const path = "parent/notes/note.md";
    const test = await fixture(undefined, path);
    await test.adapter.mkdir("parent");
    await test.adapter.mkdir("parent/notes");
    test.adapter.files.set(path, encode(test.local));
    await test.recorder.recordUpsert(path, encode(test.local));
    vi.spyOn(test.adapter, "writeText").mockRejectedValueOnce(new Error("interrupted write"));
    await expect(test.pull.pullOnce(test.session())).rejects.toThrow("interrupted write");

    test.adapter.files.delete(path);
    await test.adapter.remove("parent/notes");
    test.adapter.files.set("parent/notes", encode("replacement"));
    await test.pull.pullOnce(test.session());
    expect(test.adapter.text("parent/notes")).toBe("replacement");
    expect(await test.store.getDirtyEntryMutation("note")).toMatchObject({ op: "delete", baseRevision: 3 });
    const copies = [...test.adapter.files.keys()].filter((name) => name.includes("sync-conflict"));
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatch(/^parent\/note\.sync-conflict-/);
    expect(test.adapter.text(copies[0]!)).toBe("Remote title\n\nlocal line\n");
  });

  it("rebases a rename recorded after an interrupted merge", async () => {
    const test = await fixture();
    test.adapter.files.set("note.md", encode(test.local));
    await test.recorder.recordUpsert("note.md", encode(test.local));
    vi.spyOn(test.store, "replaceDirtyEntry").mockRejectedValueOnce(new Error("interrupted commit"));
    await expect(test.pull.pullOnce(test.session())).rejects.toThrow("interrupted commit");
    await test.adapter.rename("note.md", "new-name.md");
    const bytes = await test.adapter.readBytes("new-name.md");
    await test.recorder.recordRename("note.md", "new-name.md", bytes);
    const restarted = new SyncPullService({
      ...test.deps, getSyncToken: async () => createToken(), vaultAdapter: test.adapter,
      blobClient: test.blobClient, getConflictPolicy: () => "prefer-remote",
    });
    await restarted.pullOnce(test.session());
    const pending = (await test.store.getDirtyEntryMutation("note"))!;
    expect(pending.baseRevision).toBe(3);
    expect(await decryptSyncMetadata(TEST_VAULT_KEY, pending.encryptedMetadata, {
      entryId: "note", revision: 4, op: "upsert", blobId: pending.blobId,
    })).toMatchObject({ path: "new-name.md" });
    expect(test.adapter.text("note.md")).toBeNull();
    expect(test.adapter.text("new-name.md")).toBe("Remote title\n\nlocal line\n");
  });

  it.each(["edited", "deleted", "folder"] as const)(
    "rebases a %s file after the merge write without replaying the same remote change", async (change) => {
      const test = await fixture();
      test.adapter.files.set("note.md", encode(test.local));
      await test.recorder.recordUpsert("note.md", encode(test.local));
      vi.spyOn(test.store, "replaceDirtyEntry").mockRejectedValueOnce(new Error("interrupted commit"));
      await expect(test.pull.pullOnce(test.session())).rejects.toThrow("interrupted commit");
      const latest = "Newer title\n\nchanged again\n";
      if (change === "edited") {
        test.adapter.files.set("note.md", encode(latest));
        await test.recorder.recordUpsert("note.md", encode(latest));
      } else {
        test.adapter.files.delete("note.md");
        if (change === "folder") {
          await test.adapter.mkdir("note.md");
          test.adapter.files.set("note.md/child.md", encode("child"));
        } else {
          await test.recorder.recordDelete("note.md");
        }
      }
      const restarted = new SyncPullService({
        ...test.deps, getSyncToken: async () => createToken(), vaultAdapter: test.adapter,
        blobClient: test.blobClient, getConflictPolicy: () => "prefer-remote",
      });
      await restarted.pullOnce(createRealtimeSession({ pages: [{ cursor: 0, hasMore: false, commits: [] }] }));
      const next = createCommit({
        cursor: 91, entryId: "other", revision: 1, blobId: "remote",
        encryptedMetadata: await encryptRemoteMetadata({
          entryId: "other", revision: 1, path: "other.md", blobId: "remote", hash: await hashText(test.remote),
        }),
      });
      await restarted.pullOnce(createRealtimeSession({ pages: [{ cursor: 91, hasMore: false, commits: [test.commit, next] }] }));
      expect(test.adapter.text("other.md")).toBe(test.remote);
      expect(await test.store.getCursor()).toBe(91);
      expect([...test.adapter.files.keys()].filter((path) => path.includes("sync-conflict"))).toEqual([]);
      if (change === "edited") await expectMerged(test, latest);
      else {
        expect(await test.store.getDirtyEntryMutation("note")).toMatchObject({ op: "delete", baseRevision: 3 });
        expect(await test.store.getLocalStateById("note")).toMatchObject({ path: null, deleted: true });
        expect(await test.adapter.statKind("note.md")).toBe(change === "folder" ? "folder" : null);
        if (change === "folder") expect(test.adapter.text("note.md/child.md")).toBe("child");
      }
      expect(await test.store.textMerges.listEntryIds()).toEqual([]);
    },
  );

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

  it("replans against an edit saved while the merge journal is being persisted", async () => {
    const test = await fixture();
    test.adapter.files.set("note.md", encode(test.local));
    await test.recorder.recordUpsert("note.md", encode(test.local));
    const latest = "Title\n\nlast edit before install\n";
    const put = test.store.textMerges.put.bind(test.store.textMerges);
    let watcher: Promise<unknown> | undefined;
    vi.spyOn(test.store.textMerges, "put").mockImplementationOnce(async (intent) => {
      await put(intent);
      test.adapter.files.set("note.md", encode(latest));
      watcher = test.recorder.recordUpsertFromFile("note.md", () => test.adapter.readBytes("note.md"));
    });
    await test.pull.pullOnce(test.session());
    await watcher;
    await expectMerged(test, "Remote title\n\nlast edit before install\n");
    expect(await test.store.textMerges.listEntryIds()).toEqual([]);
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
