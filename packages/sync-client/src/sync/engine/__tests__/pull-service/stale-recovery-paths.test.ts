import { describe, expect, it, vi } from "vitest";
import { createTestContentRuntime } from "../../../../test-support/content-runtime";
import { createTestSyncStore } from "../../../../test-support/in-memory-sync-store";
import { SyncPullService } from "../../pull-service";
import { RecoveryPendingDependenciesError } from "../../pull-recovery-manifest";
import { SyncPushService } from "../../push-service";
import { SyncRealtimeError } from "../../../remote/realtime-client";
import { createPushSession } from "../push-service/helpers";
import {
  createBlobClient, createCommit, createRealtimeSession, createToken,
  createVaultAdapter, encryptPendingMetadata, encryptRemoteMetadata,
  encryptTestBlob, hashText, TEST_VAULT_KEY,
} from "./helpers";

async function setup(recoveredCursor = 90) {
  const store = createTestSyncStore();
  const path = ".obsidian/graph.json";
  const recoveredBody = '{"version":"recovered"}';
  const ownerBody = '{"version":"owner"}';
  const adapter = createVaultAdapter({ [path]: ownerBody });
  await store.applyRemoteState({
    entryId: "recovered", path: null, revision: 1, blobId: "base",
    hash: await hashText("base"), deleted: false, updatedAt: 1,
  });
  await store.upsertEntry({
    entryId: "owner", path, revision: 1, blobId: "owner-blob",
    hash: await hashText(ownerBody), deleted: false, updatedAt: 95,
  });
  await store.markEntryDirty({
    entryId: "recovered", mutationId: "stale-delete", op: "delete", baseRevision: 1,
    blobId: null, hash: null, createdAt: 1,
    encryptedMetadata: await encryptPendingMetadata({
      entryId: "recovered", baseRevision: 1, op: "delete", blobId: null, path,
    }),
  });
  await store.setCursor(100);
  const recovered = createCommit({
    cursor: recoveredCursor, entryId: "recovered", revision: 2, blobId: "recovered-blob",
    encryptedMetadata: await encryptRemoteMetadata({
      entryId: "recovered", revision: 2, blobId: "recovered-blob", path,
      hash: await hashText(recoveredBody),
    }),
  });
  const owner = createCommit({
    cursor: 95, entryId: "owner", revision: 1, blobId: "owner-blob",
    encryptedMetadata: await encryptRemoteMetadata({
      entryId: "owner", revision: 1, blobId: "owner-blob", path,
      hash: await hashText(ownerBody),
    }),
  });
  const service = new SyncPullService({
    contentRuntime: createTestContentRuntime(), getSyncToken: async () => createToken(),
    getSyncStore: () => store, getRemoteVaultKey: () => TEST_VAULT_KEY,
    shouldUseLatestRemoteVersion: (candidate) => candidate.startsWith(".obsidian/"),
    // Dependencies must remain together even with a smaller ordinary apply window.
    applyWindowSize: 1, vaultAdapter: adapter,
    blobClient: createBlobClient({ blobs: {
      "recovered-blob": await encryptTestBlob("recovered-blob", new TextEncoder().encode(recoveredBody)),
      "owner-blob": await encryptTestBlob("owner-blob", new TextEncoder().encode(ownerBody)),
    } }),
  });
  return { store, path, adapter, service, recovered, owner, recoveredBody, ownerBody };
}

describe("stale recovery path owners", () => {
  it.each(["rename", "restore"] as const)("publishes a pending local %s before recovering its path", async (kind) => {
    const test = await setup();
    const remotePath = kind === "rename" ? ".obsidian/appearance.json" : test.path;
    const localBody = '{"version":"local edit"}';
    const localHash = await hashText(localBody);
    const deleted = kind === "restore";
    await test.store.applyRemoteState({
      ...(await test.store.getRemoteStateById("owner"))!, path: remotePath,
      deleted, blobId: deleted ? null : "owner-blob", hash: deleted ? null : await hashText(test.ownerBody),
    });
    await test.adapter.writeText(test.path, localBody);
    test.adapter.writes.length = 0;
    await test.store.applyLocalState({
      entryId: "owner", path: test.path, blobId: "local-blob", hash: localHash,
      deleted: false, updatedAt: 101, localMtime: null, localSize: null,
    });
    await test.store.markEntryDirty({
      entryId: "owner", mutationId: "owner-edit", op: "upsert", baseRevision: 1,
      blobId: "local-blob", hash: localHash, createdAt: 101,
      encryptedMetadata: await encryptPendingMetadata({
        entryId: "owner", baseRevision: 1, op: "upsert", blobId: "local-blob",
        path: test.path, hash: localHash,
      }),
    });
    const owner = createCommit({
      ...test.owner, op: deleted ? "delete" : "upsert", blobId: deleted ? null : "owner-blob",
      encryptedMetadata: await encryptRemoteMetadata({
        entryId: "owner", revision: 1, blobId: deleted ? null : "owner-blob",
        path: remotePath, deleted, hash: await hashText(test.ownerBody),
      }),
    });
    const before = await test.store.getEntryStateById("owner");
    const stale = await test.store.getDirtyEntryMutation("recovered");
    await expect(test.service.recoverEntryStates(createRealtimeSession({ pages: [
      { cursor: 100, hasMore: false, commits: [test.recovered] },
      { cursor: 100, hasMore: false, commits: [owner] },
    ] }), ["recovered"])).rejects.toMatchObject({
      name: RecoveryPendingDependenciesError.name, entryIds: ["owner"],
    });
    expect(await test.store.getEntryStateById("owner")).toEqual(before);
    expect(await test.store.getDirtyEntryMutation("recovered")).toEqual(stale);
    expect(test.adapter.writes).toEqual([]);
    expect(test.adapter.text(test.path)).toBe(localBody);
    expect(await test.store.getCursor()).toBe(100);

    // Exercise the real push queue: the older stale mutation would normally be
    // first. It must not prevent the dependency's local change from committing.
    const committed: string[] = [];
    let published = owner;
    const push = new SyncPushService({
      contentRuntime: createTestContentRuntime(), getSyncStore: () => test.store,
      getSyncToken: async () => createToken(), getRemoteVaultKey: () => TEST_VAULT_KEY,
      fileReader: { readBytes: async (path) => test.adapter.bytes(path)! },
      blobClient: { uploadBlob: async () => {} },
    });
    await push.pushPendingMutations(createPushSession(async (mutation) => {
      committed.push(mutation.entryId);
      if (mutation.entryId === "recovered") {
        throw new SyncRealtimeError("stale_revision", "stale", {
          expectedBaseRevision: 2, receivedBaseRevision: 1,
        });
      }
      published = createCommit({ ...mutation, revision: 2, cursor: 101 });
      return { entryId: mutation.entryId, revision: 2, cursor: 101 };
    }), undefined, undefined, { priorityEntryIds: ["owner"] });
    expect(committed[0]).toBe("owner");
    expect(await test.store.getDirtyEntryMutation("owner")).toBeNull();
    const cursor = await test.store.getCursor();
    const session = createRealtimeSession({ pages: [
      { cursor: 101, hasMore: false, commits: [test.recovered] },
      { cursor: 101, hasMore: false, commits: [published] },
    ] });
    await test.service.recoverEntryStates(session, ["recovered"]);
    expect(test.adapter.text(test.path)).toBe(localBody);
    expect(test.adapter.writes).toEqual([]);
    expect(await test.store.getDirtyEntryMutation("recovered")).toBeNull();
    expect(await test.store.getCursor()).toBe(cursor);
    await test.store.close();
  });

  it.each([90, 99])("selects the latest config entry when the recovered cursor is %s", async (cursor) => {
    const test = await setup(cursor);
    const session = createRealtimeSession({ pages: [
      { cursor: 100, hasMore: false, commits: [test.recovered] },
      { cursor: 100, hasMore: false, commits: [test.owner] },
    ] });
    const list = vi.spyOn(session, "listEntryStates");
    await test.service.recoverEntryStates(session, ["recovered"]);
    const recoveredWins = cursor > 95;
    expect(test.adapter.text(test.path)).toBe(recoveredWins ? test.recoveredBody : test.ownerBody);
    expect((await test.store.getEntryByPath(test.path))?.entryId).toBe(recoveredWins ? "recovered" : "owner");
    expect(await test.store.getDirtyEntryMutation("recovered")).toBeNull();
    expect(await test.store.getCursor()).toBe(100);
    expect(list).toHaveBeenLastCalledWith({
      sinceCursor: 0, targetCursor: 100, after: null, limit: 100, entryIds: ["owner"],
    });
    await test.store.close();
  });

  it("loads competing owners through legacy unfiltered pages", async () => {
    const test = await setup();
    const unrelated = createCommit({ entryId: "unrelated", cursor: 1, encryptedMetadata: "invalid" });
    const pages = [
      { cursor: 100, hasMore: true, commits: [unrelated, test.recovered] },
      { cursor: 100, hasMore: false, commits: [test.owner] },
    ];
    const session = createRealtimeSession({ pages: [pages[0]!, ...pages] });
    await test.service.recoverEntryStates(session, ["recovered"]);
    expect(test.adapter.text(test.path)).toBe(test.ownerBody);
    expect(await test.store.getDirtyEntryMutation("recovered")).toBeNull();
    expect(await test.store.getCursor()).toBe(100);
    await test.store.close();
  });

  it("preserves pending edits on an already-applied winning owner", async () => {
    const test = await setup();
    const localBody = '{"version":"local edit"}';
    await test.adapter.writeText(test.path, localBody);
    test.adapter.writes.length = 0;
    await test.store.markEntryDirty({
      entryId: "owner", mutationId: "owner-edit", op: "upsert", baseRevision: 1,
      blobId: "local-blob", hash: await hashText(localBody), createdAt: 101,
      encryptedMetadata: await encryptPendingMetadata({
        entryId: "owner", baseRevision: 1, op: "upsert", blobId: "local-blob",
        path: test.path, hash: await hashText(localBody),
      }),
    });
    const pending = await test.store.getDirtyEntryMutation("owner");
    const session = createRealtimeSession({ pages: [
      { cursor: 100, hasMore: false, commits: [test.recovered] },
      { cursor: 100, hasMore: false, commits: [test.owner] },
    ] });
    await test.service.recoverEntryStates(session, ["recovered"]);
    expect(test.adapter.text(test.path)).toBe(localBody);
    expect(test.adapter.writes).toEqual([]);
    expect(await test.store.getDirtyEntryMutation("owner")).toEqual(pending);
    expect(await test.store.getDirtyEntryMutation("recovered")).toBeNull();
    expect(await test.store.getCursor()).toBe(100);
    await test.store.close();
  });

  it.each([1, 2])("reconciles a dependency on an older pending base with stored revision %s", async (storedRevision) => {
    const test = await setup();
    await test.store.applyRemoteState({
      ...(await test.store.getRemoteStateById("owner"))!, revision: storedRevision,
    });
    await test.adapter.writeText(test.path, "local edit");
    await test.store.markEntryDirty({
      entryId: "owner", mutationId: "old-base-edit", op: "upsert", baseRevision: 1,
      blobId: "local-blob", hash: await hashText("local edit"), createdAt: 101,
      encryptedMetadata: await encryptPendingMetadata({
        entryId: "owner", baseRevision: 1, op: "upsert", blobId: "local-blob",
        path: test.path, hash: await hashText("local edit"),
      }),
    });
    const owner = createCommit({
      ...test.owner, revision: 2, encryptedMetadata: await encryptRemoteMetadata({
        entryId: "owner", revision: 2, blobId: "owner-blob", path: test.path,
        hash: await hashText(test.ownerBody),
      }),
    });
    await test.service.recoverEntryStates(createRealtimeSession({ pages: [
      { cursor: 100, hasMore: false, commits: [test.recovered] },
      { cursor: 100, hasMore: false, commits: [owner] },
    ] }), ["recovered"]);
    expect(test.adapter.text(test.path)).toBe(test.ownerBody);
    expect(await test.store.getDirtyEntryMutation("owner")).toBeNull();
    expect(await test.store.getDirtyEntryMutation("recovered")).toBeNull();
    expect((await test.store.getRemoteStateById("owner"))?.revision).toBe(2);
    expect(await test.store.getCursor()).toBe(100);
    await test.store.close();
  });

  it("compares owners across request batches before writing any older version", async () => {
    const test = await setup();
    const session = createRealtimeSession({ pages: [
      { cursor: 100, hasMore: false, commits: [test.recovered] },
      { cursor: 100, hasMore: false, commits: [test.owner] },
    ] });
    const list = vi.spyOn(session, "listEntryStates");
    await test.service.recoverEntryStates(session, [
      "recovered", ...Array.from({ length: 99 }, (_, i) => `missing-${i}`), "owner", "recovered",
    ]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[0]![0].entryIds).toHaveLength(100);
    expect(list.mock.calls[1]![0]).toMatchObject({ targetCursor: 100, entryIds: ["owner"] });
    expect(test.adapter.writes).toEqual([]);
    expect(test.adapter.text(test.path)).toBe(test.ownerBody);
    expect(await test.store.getDirtyEntryMutation("recovered")).toBeNull();
    expect(await test.store.getCursor()).toBe(100);
    await test.store.close();
  });

  it("follows a cycle of moving owners and applies the paths together", async () => {
    const store = createTestSyncStore();
    const adapter = createVaultAdapter({ "a.md": "a", "b.md": "b", "c.md": "c" });
    const commits = [];
    const blobs: Record<string, Uint8Array> = {};
    for (const [id, target] of [["a", "b"], ["b", "c"], ["c", "a"]] as const) {
      const hash = await hashText(id);
      await store.upsertEntry({
        entryId: id, path: `${id}.md`, revision: 1, blobId: `base-${id}`,
        hash, deleted: false, updatedAt: 1,
      });
      blobs[id] = await encryptTestBlob(id, new TextEncoder().encode(id));
      commits.push(createCommit({
        entryId: id, revision: 2, blobId: id, cursor: 90 + commits.length,
        encryptedMetadata: await encryptRemoteMetadata({
          entryId: id, revision: 2, blobId: id, path: `${target}.md`, hash,
        }),
      }));
    }
    await store.setCursor(100);
    const session = createRealtimeSession({ pages: commits.map((commit) => ({
      cursor: 100, hasMore: false, commits: [commit],
    })) });
    const list = vi.spyOn(session, "listEntryStates");
    const service = new SyncPullService({
      contentRuntime: createTestContentRuntime(), getSyncToken: async () => createToken(),
      getSyncStore: () => store, getRemoteVaultKey: () => TEST_VAULT_KEY,
      vaultAdapter: adapter, blobClient: createBlobClient({ blobs }), applyWindowSize: 1,
    });
    await service.recoverEntryStates(session, ["a"]);
    expect(list).toHaveBeenCalledTimes(3);
    expect(adapter.text("a.md")).toBe("c");
    expect(adapter.text("b.md")).toBe("a");
    expect(adapter.text("c.md")).toBe("b");
    expect(adapter.writes.some((path) => path.includes("sync-conflict"))).toBe(false);
    expect(await store.getCursor()).toBe(100);
    await store.close();
  });

  it.each(["missing", "changed snapshot", "rollback"])("preserves files and pending changes for a %s owner", async (failure) => {
    const test = await setup();
    if (failure === "rollback") {
      await test.store.applyRemoteState({
        ...(await test.store.getRemoteStateById("owner"))!, revision: 2,
      });
    }
    const pending = await test.store.getDirtyEntryMutation("recovered");
    const session = createRealtimeSession({ pages: [
      { cursor: 100, hasMore: false, commits: [test.recovered] },
      { cursor: failure === "changed snapshot" ? 101 : 100, hasMore: false,
        commits: failure === "missing" ? [] : [test.owner] },
    ] });
    await expect(test.service.recoverEntryStates(session, ["recovered"])).rejects.toThrow();
    expect(test.adapter.writes).toEqual([]);
    expect(test.adapter.text(test.path)).toBe(test.ownerBody);
    expect(await test.store.getDirtyEntryMutation("recovered")).toEqual(pending);
    expect((await test.store.getEntryByPath(test.path))?.entryId).toBe("owner");
    expect(await test.store.getCursor()).toBe(100);
    await test.store.close();
  });
});
