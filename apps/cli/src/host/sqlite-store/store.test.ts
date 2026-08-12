import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InMemorySyncStore } from "@synch/sync-client/test-support/in-memory-sync-store";
import { encryptSyncMetadata } from "@synch/sync-client/sync/core/crypto";
import type {
  AcceptedPushMutationRow,
  PendingMutationRow,
  SyncStore,
} from "@synch/sync-client/sync/store/store";
import { SqliteSyncStore } from "./store";

let tempDir: string;
let store: SqliteSyncStore;

const remoteVaultKey = crypto.getRandomValues(new Uint8Array(32));

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synch-sqlite-store-"));
  store = SqliteSyncStore.open(path.join(tempDir, "sync.sqlite"));
});

afterEach(async () => {
  await store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function connect(target: SyncStore, remoteVaultId = "vault-1") {
  await target.writeSyncConnection({
    localVaultId: await target.readLocalVaultId(),
    remoteVaultId,
    lastPulledCursor: 0,
  });
}

async function makePendingUpsert(
  entryId: string,
  filePath: string,
  overrides: Partial<PendingMutationRow> = {},
): Promise<PendingMutationRow> {
  const baseRevision = overrides.baseRevision ?? 0;
  const blobId = overrides.blobId ?? `blob-${entryId}`;
  const hash = overrides.hash ?? `hash-${entryId}`;
  return {
    mutationId: overrides.mutationId ?? crypto.randomUUID(),
    entryId,
    op: "upsert",
    baseRevision,
    blobId,
    hash,
    encryptedMetadata: await encryptSyncMetadata(
      remoteVaultKey,
      { path: filePath, hash },
      { entryId, revision: baseRevision + 1, op: "upsert", blobId },
    ),
    createdAt: overrides.createdAt ?? Date.now(),
    ...overrides,
  };
}

describe("SqliteSyncStore basics", () => {
  it("persists the generated local vault id across reopen", async () => {
    const localVaultId = await store.readLocalVaultId();
    expect(localVaultId).not.toBe("");
    await store.close();

    store = SqliteSyncStore.open(path.join(tempDir, "sync.sqlite"));
    expect(await store.readLocalVaultId()).toBe(localVaultId);
  });

  it("stores and reads the sync connection and cursor", async () => {
    expect(await store.readSyncConnection()).toBeNull();
    await connect(store);

    const connection = await store.readSyncConnection();
    expect(connection).toEqual({
      localVaultId: await store.readLocalVaultId(),
      remoteVaultId: "vault-1",
      lastPulledCursor: 0,
    });

    await store.setCursor(42);
    expect(await store.getCursor()).toBe(42);
  });

  it("rejects a connection for a different local vault", async () => {
    await expect(
      store.writeSyncConnection({
        localVaultId: "other-local-vault",
        remoteVaultId: "vault-1",
        lastPulledCursor: 0,
      }),
    ).rejects.toThrow();
    expect((await store.readSyncConnection())?.localVaultId).not.toBe(
      "other-local-vault",
    );
  });

  it("round-trips remote and local entry state", async () => {
    await store.applyRemoteState({
      entryId: "e1",
      path: "notes/a.md",
      revision: 3,
      blobId: "b1",
      hash: "h1",
      deleted: false,
      updatedAt: 100,
    });
    await store.applyLocalState({
      entryId: "e1",
      path: "notes/a.md",
      blobId: "b1",
      hash: "h1",
      deleted: false,
      updatedAt: 100,
      localMtime: 99,
      localSize: 10,
    });

    expect((await store.getRemoteStateByPath("notes/a.md"))?.entryId).toBe("e1");
    expect((await store.getLocalStateByPath("notes/a.md"))?.localSize).toBe(10);
    expect((await store.getEntryByPath("notes/a.md"))?.revision).toBe(3);
    const state = await store.getEntryStateById("e1");
    expect(state?.base.revision).toBe(3);
    expect(state?.dirty).toBeNull();

    await store.clearLocalState("e1");
    expect(await store.getLocalStateById("e1")).toBeNull();
    expect((await store.getRemoteStateById("e1"))?.revision).toBe(3);

    await store.clearRemoteState("e1");
    expect(await store.getEntryById("e1")).toBeNull();
  });

  it("rejects a second entry claiming the same visible path instead of replacing it", async () => {
    await store.applyLocalState({
      entryId: "e1",
      path: "notes/a.md",
      blobId: "b1",
      hash: "h1",
      deleted: false,
      updatedAt: 100,
      localMtime: 99,
      localSize: 10,
    });

    await expect(
      store.applyLocalState({
        entryId: "e2",
        path: "notes/a.md",
        blobId: "b2",
        hash: "h2",
        deleted: false,
        updatedAt: 200,
        localMtime: 199,
        localSize: 20,
      }),
    ).rejects.toThrow();

    // The original entry must survive the failed write.
    expect((await store.getLocalStateById("e1"))?.path).toBe("notes/a.md");
    expect(await store.getEntryById("e2")).toBeNull();
  });

  it("lists dirty entries in creation order and honors limits", async () => {
    for (const [index, entryId] of ["e1", "e2", "e3"].entries()) {
      await store.markEntryDirty(
        await makePendingUpsert(entryId, `${entryId}.md`, {
          createdAt: 1000 + index,
        }),
      );
    }

    const all = await store.listDirtyEntries();
    expect(all.map((mutation) => mutation.entryId)).toEqual(["e1", "e2", "e3"]);
    const limited = await store.listDirtyEntries(2);
    expect(limited.map((mutation) => mutation.entryId)).toEqual(["e1", "e2"]);
  });

  it("tracks blocked mutations separately and unblocks them", async () => {
    const blocked = await makePendingUpsert("e1", "big.bin", {
      status: "blocked",
      blockedReason: "file_too_large",
      blockedEncryptedSizeBytes: 1234,
      blockedMaxFileSizeBytes: 1000,
    });
    await store.markEntryDirty(blocked);

    expect(await store.listDirtyEntries()).toEqual([]);
    const blockedRows = await store.listBlockedDirtyEntriesByReason("file_too_large");
    expect(blockedRows).toHaveLength(1);
    expect(blockedRows[0].blockedEncryptedSizeBytes).toBe(1234);

    await store.unblockDirtyEntriesByReason("file_too_large");
    expect(await store.listBlockedDirtyEntriesByReason("file_too_large")).toEqual([]);
    expect(await store.listDirtyEntries()).toHaveLength(1);
  });

  it("clears dirty state by mutation id and by entry", async () => {
    const mutation = await makePendingUpsert("e1", "a.md");
    await store.markEntryDirty(mutation);
    await store.clearDirtyEntryByMutationId(mutation.mutationId);
    expect(await store.getDirtyEntryMutation("e1")).toBeNull();

    await store.markEntryDirty(await makePendingUpsert("e2", "b.md"));
    await store.markEntryClean("e2");
    expect(await store.getDirtyEntryMutation("e2")).toBeNull();
  });

  it("requires the cached base blob when requested", async () => {
    const mutation = await makePendingUpsert("e1", "a.md", {
      baseBlobId: "base-blob",
      baseHash: "base-hash",
    });
    await expect(
      store.markEntryDirty(mutation, { requireBaseBlob: true }),
    ).rejects.toThrow();
    expect(await store.getDirtyEntryMutation("e1")).toBeNull();

    await store.putBlob({
      blobId: "base-blob",
      hash: "base-hash",
      encryptedBytes: new Uint8Array([1, 2, 3]),
      cachedAt: Date.now(),
    });
    await store.markEntryDirty(mutation, { requireBaseBlob: true });
    expect(await store.getDirtyEntryMutation("e1")).not.toBeNull();
  });

  it("round-trips blobs", async () => {
    await store.putBlob({
      blobId: "b1",
      hash: "h1",
      encryptedBytes: new Uint8Array([9, 8, 7]),
      cachedAt: 123,
      role: "remote",
      refEntryId: "e1",
    });

    const blob = await store.getBlob("b1");
    expect(blob?.hash).toBe("h1");
    expect([...(blob?.encryptedBytes ?? [])]).toEqual([9, 8, 7]);
    expect(await store.getBlob("missing")).toBeNull();
  });

  it("applies reconcile updates transactionally", async () => {
    await store.upsertEntry({
      entryId: "e1",
      path: "a.md",
      revision: 1,
      blobId: "b1",
      hash: "h1",
      deleted: false,
      updatedAt: 10,
      localMtime: 1,
      localSize: 2,
    });

    await store.applyReconcileEntryUpdates([
      {
        entryId: "e1",
        local: {
          entryId: "e1",
          path: "a-renamed.md",
          blobId: "b1",
          hash: "h1",
          deleted: false,
          updatedAt: 20,
          localMtime: 3,
          localSize: 2,
        },
        dirty: await makePendingUpsert("e1", "a-renamed.md", { baseRevision: 1 }),
      },
      { entryId: "e2", deleteEntry: true },
    ]);

    expect((await store.getLocalStateById("e1"))?.path).toBe("a-renamed.md");
    expect(await store.getDirtyEntryMutation("e1")).not.toBeNull();

    await store.applyReconcileEntryUpdates([{ entryId: "e1", clearDirty: true }]);
    expect(await store.getDirtyEntryMutation("e1")).toBeNull();
  });
});

describe("SqliteSyncStore parity with InMemorySyncStore", () => {
  it("stays consistent with the reference store across a sync scenario", async () => {
    const reference = new InMemorySyncStore(await store.readLocalVaultId());
    await connect(store);

    const pendingMutation = await makePendingUpsert("e3", "pending.md", {
      mutationId: "m-e3",
      blobId: "b-e3",
      hash: "h-e3",
      createdAt: 31,
    });
    for (const target of [store, reference] as SyncStore[]) {
      await runScenario(target, pendingMutation);
    }

    expect(await store.countSyncProgress()).toEqual(
      await reference.countSyncProgress(),
    );
    expect(await store.listEntries()).toEqual(await reference.listEntries());
    expect(await store.listRemoteStates()).toEqual(
      await reference.listRemoteStates(),
    );
    expect(await store.listLocalStates()).toEqual(
      await reference.listLocalStates(),
    );
    expect(await store.listDirtyEntries()).toEqual(
      await reference.listDirtyEntries(),
    );
    for (const entryId of ["e1", "e2", "e3", "e4"]) {
      expect(await store.getEntryStateById(entryId)).toEqual(
        await reference.getEntryStateById(entryId),
      );
    }
  });

  it("applies accepted pushes like the reference store, including rebases", async () => {
    const reference = new InMemorySyncStore(await store.readLocalVaultId());
    await connect(store);

    const acceptedMutation = await makePendingUpsert("e1", "a.md", {
      mutationId: "m1",
      createdAt: 100,
    });
    const replacedMutation = await makePendingUpsert("e1", "a.md", {
      mutationId: "m2",
      blobId: "blob-next",
      hash: "hash-next",
      createdAt: 200,
    });

    const accepted: AcceptedPushMutationRow[] = [
      {
        mutation: acceptedMutation,
        metadata: { path: "a.md", hash: acceptedMutation.hash },
        acceptedRevision: 7,
        remoteBlobId: "remote-blob",
        localHash: acceptedMutation.hash,
        acceptedAt: 500,
        remoteCacheBlob: {
          blobId: "remote-blob",
          hash: acceptedMutation.hash,
          encryptedBytes: new Uint8Array([1]),
          cachedAt: 500,
          role: "base",
          refEntryId: "e1",
        },
      },
    ];

    for (const target of [store, reference] as SyncStore[]) {
      await target.markEntryDirty(acceptedMutation);
      // Local file changed again while the push was in flight.
      await target.replaceDirtyEntry(replacedMutation);
      await target.applyAcceptedPushBatch(accepted, { remoteVaultKey });
    }

    const sqliteState = await store.getEntryStateById("e1");
    const referenceState = await reference.getEntryStateById("e1");
    expect(sqliteState?.remote).toEqual(referenceState?.remote);
    expect(sqliteState?.base).toEqual(referenceState?.base);
    expect(sqliteState?.local).toEqual(referenceState?.local);

    // The still-pending mutation is rebased onto the accepted revision.
    expect(sqliteState?.dirty?.mutationId).toBe("m2");
    expect(sqliteState?.dirty?.baseRevision).toBe(7);
    expect(sqliteState?.dirty?.baseBlobId).toBe("remote-blob");
    expect(referenceState?.dirty?.baseRevision).toBe(7);
    expect(sqliteState?.dirty?.encryptedMetadata).not.toBe(
      replacedMutation.encryptedMetadata,
    );

    expect(await store.getBlob("remote-blob")).not.toBeNull();
    expect(await store.countSyncProgress()).toEqual(
      await reference.countSyncProgress(),
    );
  });
});

async function runScenario(
  target: SyncStore,
  pendingMutation: PendingMutationRow,
): Promise<void> {
  // Remote-only entry.
  await target.applyRemoteState({
    entryId: "e1",
    path: "remote-only.md",
    revision: 2,
    blobId: "b-e1",
    hash: "h-e1",
    deleted: false,
    updatedAt: 10,
  });

  // Fully synced entry.
  await target.upsertEntry({
    entryId: "e2",
    path: "synced.md",
    revision: 5,
    blobId: "b-e2",
    hash: "h-e2",
    deleted: false,
    updatedAt: 20,
    localMtime: 19,
    localSize: 100,
  });

  // Local entry with a pending upsert.
  await target.applyLocalState({
    entryId: "e3",
    path: "pending.md",
    blobId: "b-e3",
    hash: "h-e3",
    deleted: false,
    updatedAt: 30,
    localMtime: 29,
    localSize: 5,
  });
  await target.markEntryDirty(pendingMutation);

  // Entry that gets deleted again.
  await target.applyRemoteState({
    entryId: "e4",
    path: "deleted.md",
    revision: 1,
    blobId: "b-e4",
    hash: "h-e4",
    deleted: false,
    updatedAt: 40,
  });
  await target.applyRemoteState({
    entryId: "e4",
    path: null,
    revision: 2,
    blobId: null,
    hash: null,
    deleted: true,
    updatedAt: 41,
  });

  // A remote update arriving while e3 is dirty must not move its base.
  await target.applyRemoteState({
    entryId: "e3",
    path: "pending.md",
    revision: 9,
    blobId: "b-e3-remote",
    hash: "h-e3-remote",
    deleted: false,
    updatedAt: 50,
  });
}
