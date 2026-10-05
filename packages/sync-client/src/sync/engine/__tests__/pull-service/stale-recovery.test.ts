import { describe, expect, it, vi } from "vitest";
import { createTestContentRuntime } from "../../../../test-support/content-runtime";
import { createTestSyncStore } from "../../../../test-support/in-memory-sync-store";
import { decryptSyncMetadata } from "../../../core/crypto";
import { SyncPullService } from "../../pull-service";
import {
  arrangePendingUpsertWithCachedBase, createBlobClient, createCommit,
  createRealtimeSession, createToken, createVaultAdapter, encryptRemoteMetadata,
  encryptTestBlob, hashText, TEST_VAULT_KEY,
} from "./helpers";

async function setup(remoteBody = "Remote title\n\noriginal line\n") {
  const baseBody = "Title\n\noriginal line\n";
  const localBody = "Title\n\nlocal line\n";
  const store = createTestSyncStore();
  const adapter = createVaultAdapter({ "note.md": localBody, "other.md": "keep me" });
  await arrangePendingUpsertWithCachedBase(store, {
    entryId: "note", path: "note.md", baseRevision: 2, baseBlobId: "base",
    baseHash: await hashText(baseBody), baseBytes: new TextEncoder().encode(baseBody),
    localBlobId: "local", localHash: await hashText(localBody), createdAt: 1,
  });
  await store.setCursor(100);
  const encryptedMetadata = await encryptRemoteMetadata({
    entryId: "note", revision: 3, blobId: "remote", path: "note.md", hash: await hashText(remoteBody),
  });
  const commit = createCommit({ cursor: 90, entryId: "note", revision: 3, blobId: "remote", encryptedMetadata });
  const service = new SyncPullService({
    contentRuntime: createTestContentRuntime(), getSyncToken: async () => createToken(),
    getSyncStore: () => store, getRemoteVaultKey: () => TEST_VAULT_KEY, vaultAdapter: adapter,
    blobClient: createBlobClient({ blobs: { remote: await encryptTestBlob("remote", new TextEncoder().encode(remoteBody)) } }),
  });
  return { store, adapter, commit, service, localBody, remoteBody };
}

describe("targeted stale entry recovery", () => {
  it("recovers a revision behind the cursor and re-encrypts the merged pending edit", async () => {
    const test = await setup();
    const session = createRealtimeSession({ pages: [
      { cursor: 100, hasMore: false, commits: [] },
      { cursor: 101, hasMore: false, commits: [test.commit] },
    ] });
    const list = vi.spyOn(session, "listEntryStates");
    await test.service.pullOnce(session);
    expect((await test.store.getDirtyEntryMutation("note"))?.baseRevision).toBe(2);
    await test.service.recoverEntryStates(session, ["note"]);
    expect(list).toHaveBeenLastCalledWith({
      sinceCursor: 0, targetCursor: null, after: null, limit: 100, entryIds: ["note"],
    });
    const pending = await test.store.getDirtyEntryMutation("note");
    expect(pending).toMatchObject({ baseRevision: 3, baseBlobId: "remote" });
    expect(test.adapter.text("note.md")).toBe("Remote title\n\nlocal line\n");
    expect(await decryptSyncMetadata(TEST_VAULT_KEY, pending!.encryptedMetadata, {
      entryId: "note", revision: 4, op: "upsert", blobId: pending!.blobId,
    })).toMatchObject({ path: "note.md", hash: await hashText("Remote title\n\nlocal line\n") });
    // Cursor 101 may include unrelated changes that recovery has not applied.
    expect(await test.store.getCursor()).toBe(100);
    expect(test.adapter.text("other.md")).toBe("keep me");
    await test.store.close();
  });

  it("pages safely through an older server that ignores entry IDs without applying unrelated files", async () => {
    const test = await setup();
    const session = createRealtimeSession({ pages: [
      { cursor: 100, hasMore: true, commits: [createCommit({ entryId: "other", cursor: 1, encryptedMetadata: "not decryptable" })] },
      { cursor: 100, hasMore: true, commits: [test.commit] },
    ] });
    const list = vi.spyOn(session, "listEntryStates");
    await test.service.recoverEntryStates(session, ["note"]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({
      sinceCursor: 0, targetCursor: 100, after: { updatedSeq: 1, entryId: "other" },
    }));
    expect(test.adapter.text("other.md")).toBe("keep me");
    expect((await test.store.getDirtyEntryMutation("note"))?.baseRevision).toBe(3);
    expect(await test.store.getCursor()).toBe(100);
    await test.store.close();
  });

  it("preserves overlapping local edits as a conflict copy", async () => {
    const test = await setup("Title\n\nconflicting remote line\n");
    const session = createRealtimeSession({ pages: [{ cursor: 100, hasMore: false, commits: [test.commit] }] });
    await test.service.recoverEntryStates(session, ["note"]);
    expect(test.adapter.text("note.md")).toBe(test.remoteBody);
    const conflictPath = test.adapter.writes.find((path) => path.includes("sync-conflict"));
    expect(conflictPath).toBeDefined();
    expect(test.adapter.text(conflictPath!)).toBe(test.localBody);
    expect(await test.store.getDirtyEntryMutation("note")).toBeNull();
    expect(await test.store.getCursor()).toBe(100);
    await test.store.close();
  });

  it("preserves the pending edit and cursor when the server omits the entry", async () => {
    const test = await setup();
    const before = await test.store.getDirtyEntryMutation("note");
    await test.service.recoverEntryStates(createRealtimeSession({ pages: [{ cursor: 100, hasMore: false, commits: [] }] }), ["note"]);
    expect(await test.store.getDirtyEntryMutation("note")).toEqual(before);
    expect(test.adapter.text("note.md")).toBe(test.localBody);
    expect(await test.store.getCursor()).toBe(100);
    await test.store.close();
  });

  it("rejects a recovery snapshot older than the local cursor before changing files", async () => {
    const test = await setup();
    const session = createRealtimeSession({ pages: [{ cursor: 99, hasMore: false, commits: [test.commit] }] });
    await expect(test.service.recoverEntryStates(session, ["note"]))
      .rejects.toMatchObject({ code: "cursor_ahead_of_server" });
    expect(test.adapter.writes).toEqual([]);
    expect(await test.store.getCursor()).toBe(100);
    await test.store.close();
  });

  it("keeps per-entry rollback protection during recovery", async () => {
    const test = await setup();
    const pending = await test.store.getDirtyEntryMutation("note");
    await test.store.applyRemoteState({
      entryId: "note", path: "note.md", revision: 4, blobId: "newer-remote",
      hash: await hashText("newer remote"), deleted: false, updatedAt: 95,
    });
    const session = createRealtimeSession({ pages: [{ cursor: 100, hasMore: false, commits: [test.commit] }] });
    await test.service.recoverEntryStates(session, ["note"]);
    expect((await test.store.getRemoteStateById("note"))?.revision).toBe(4);
    expect(await test.store.getDirtyEntryMutation("note")).toEqual(pending);
    expect(test.adapter.writes).toEqual([]);
    expect(test.adapter.text("note.md")).toBe(test.localBody);
    expect(await test.store.getCursor()).toBe(100);
    await test.store.close();
  });

  it("stops pagination that repeats the same page", async () => {
    const test = await setup();
    const page = { cursor: 100, hasMore: true, commits: [createCommit({ entryId: "other", cursor: 1 })] };
    const session = createRealtimeSession({ pages: [page, page] });
    await expect(test.service.recoverEntryStates(session, ["note"])).rejects.toThrow("pagination did not advance");
    expect(test.adapter.writes).toEqual([]);
    expect(await test.store.getCursor()).toBe(100);
    await test.store.close();
  });
});
