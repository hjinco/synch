import { describe, expect, it, vi } from "vitest";
import { createTestContentRuntime } from "../../../../test-support/content-runtime";
import { createTestSyncStore } from "../../../../test-support/in-memory-sync-store";
import { SyncEventRecorder } from "../../event-recorder";
import { SyncPullService } from "../../pull-service";
import {
  createBlobClient, createCommit, createRealtimeSession, createToken, createVaultAdapter,
  encryptRemoteMetadata, encryptTestBlob, hashText, TEST_VAULT_KEY,
} from "./helpers";

const encode = (value: string) => new TextEncoder().encode(value);
const base = "a\nb\nc\nd\ne\n";
const remote = "A\nb\nC\nd\ne\n";
const partial = remote.slice(0, -2);
const local = "A\nb\nc\nd\ne\n";

async function fixture(path: string, create = false) {
  const store = createTestSyncStore();
  const vault = createVaultAdapter(create ? {} : { [path]: base });
  const adapter = {
    ...vault,
    async writeBytesIfAbsent(path: string, bytes: Uint8Array) {
      if (vault.files.has(path)) return false;
      vault.files.set(path, bytes.slice());
      return true;
    },
  };
  const hash = await hashText(remote);
  if (!create) {
    const hash = await hashText(base);
    await store.upsertEntry({
      entryId: "entry", path, hash, revision: 2, blobId: "base", deleted: false, updatedAt: 2,
    });
    await store.putBlob({
      blobId: "base", hash, role: "remote", refEntryId: "entry", cachedAt: 2,
      encryptedBytes: await encryptTestBlob("base", encode(base)),
    });
  }
  const commit = createCommit({
    entryId: "entry", cursor: 3, revision: 3, blobId: "remote",
    encryptedMetadata: await encryptRemoteMetadata({ entryId: "entry", path, revision: 3, blobId: "remote", hash }),
  });
  const deps = {
    getSyncStore: () => store, getRemoteVaultKey: () => TEST_VAULT_KEY,
    contentRuntime: createTestContentRuntime(), getSyncToken: async () => createToken(), vaultAdapter: adapter,
    blobClient: createBlobClient({ blobs: { remote: await encryptTestBlob("remote", encode(remote)) } }),
  };
  return {
    store, adapter, service: () => new SyncPullService(deps), recorder: new SyncEventRecorder(deps),
    session: () => createRealtimeSession({ pages: [{ cursor: 3, hasMore: false, commits: [commit] }] }),
  };
}

describe("interrupted download recovery", () => {
  it.each(["create", "update", "remote-text"])("recovers a truncated Markdown %s before a scan or push", async (kind) => {
    const path = "note.md";
    const t = await fixture(path, kind === "create");
    if (kind === "remote-text") {
      t.adapter.files.set(path, encode(local));
      await t.recorder.recordUpsert(path, encode(local));
    }
    const interrupt = async () => {
      t.adapter.files.set(path, encode(partial));
      throw new Error("interrupted write");
    };
    if (kind === "create") vi.spyOn(t.adapter, "writeBytesIfAbsent").mockImplementationOnce(interrupt);
    else vi.spyOn(t.adapter, "writeText").mockImplementationOnce(interrupt);
    await expect(t.service().pullOnce(t.session())).rejects.toThrow("interrupted write");
    expect((await t.store.textMerges.get("entry"))?.kind).toBe("download");

    const restarted = t.service();
    await restarted.recoverPendingWrites();
    expect(t.adapter.text(path)).toBe(remote);
    expect(await t.store.getRemoteStateById("entry")).toMatchObject({ revision: 3, hash: await hashText(remote) });
    expect(await t.store.listDirtyEntries()).toEqual([]);
    const copies = [...t.adapter.files.keys()].filter((name) => name.includes(".sync-conflict-"));
    expect(copies.map((name) => t.adapter.text(name))).toEqual([partial]);
    await restarted.pullOnce(t.session());
    expect(await t.store.getCursor()).toBe(3);
    expect(await t.store.listDirtyEntries()).toEqual([]);
  });

  it.each(["interrupt", "save"])("preserves a binary recovery competing with another %s", async (action) => {
    const path = "picture.bin";
    const t = await fixture(path);
    vi.spyOn(t.adapter, "writeBinary").mockImplementationOnce(async (path) => {
      t.adapter.files.set(path, encode(partial));
      throw new Error("interrupted write");
    });
    await expect(t.service().pullOnce(t.session())).rejects.toThrow("interrupted write");
    const saved = encode("my independent binary edit");
    vi.spyOn(t.adapter, "writeBytesIfAbsent").mockImplementationOnce(async () => {
      expect(t.adapter.files.has(path)).toBe(false);
      if (action === "interrupt") throw new Error("lost power");
      t.adapter.files.set(path, saved);
      return false;
    });
    await expect(t.service().recoverPendingWrites()).rejects.toThrow();
    expect((await t.store.textMerges.get("entry"))?.kind).toBe("download");
    await t.service().recoverPendingWrites();
    expect(t.adapter.files.get(path)).toEqual(action === "interrupt" ? encode(remote) : saved);
    expect(await t.store.textMerges.listEntryIds()).toEqual([]);
    expect(await t.store.listDirtyEntries()).toEqual([]);
  });

  it("repairs a partial file at its new name before queueing the rename", async () => {
    const path = "note.md";
    const renamed = "renamed.md";
    const t = await fixture(path);
    vi.spyOn(t.adapter, "writeText").mockImplementationOnce(async () => {
      t.adapter.files.set(path, encode(partial));
      throw new Error("interrupted write");
    });
    await expect(t.service().pullOnce(t.session())).rejects.toThrow("interrupted write");
    await t.adapter.rename(path, renamed);
    await t.recorder.recordRename(path, renamed, await t.adapter.readBytes(renamed));

    const restarted = t.service();
    await restarted.recoverPendingWrites();
    await restarted.pullOnce(t.session());
    expect(t.adapter.text(path)).toBeNull();
    expect(t.adapter.text(renamed)).toBe(remote);
    expect(await t.store.listDirtyEntries()).toMatchObject([{
      entryId: "entry", op: "upsert", baseRevision: 3, hash: await hashText(remote),
    }]);
    expect(await t.store.getLocalStateById("entry")).toMatchObject({ path: renamed });
  });

  it("replans an ordinary write when an edit arrives during journal persistence", async () => {
    const path = "note.md";
    const t = await fixture(path);
    const put = t.store.textMerges.put.bind(t.store.textMerges);
    vi.spyOn(t.store.textMerges, "put").mockImplementationOnce(async (intent) => {
      await put(intent);
      t.adapter.files.set(path, encode(base.replace("e", "E")));
    });
    await t.service().pullOnce(t.session());
    expect(t.adapter.text(path)).toBe(remote.replace("e", "E"));
    expect(await t.store.getDirtyEntryMutation("entry")).toMatchObject({ baseRevision: 3 });
  });
});
