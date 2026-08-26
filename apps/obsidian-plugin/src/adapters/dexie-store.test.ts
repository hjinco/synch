import { describe, expect, it } from "vitest";

import type { Plugin } from "obsidian";

import {
  clearDexieSyncStore,
  createDexieSyncStore,
  readDexieSyncStoreConnection,
} from "./dexie-store";
import { replacePendingMutationForEntry } from "@synch/sync-client/sync/core/mutation-queue";

describe("DexieSyncStore", () => {
  it("creates and persists entry ids by path", async () => {
    const plugin = createPlugin();

    const firstStore = await createDexieSyncStore(plugin);
    const firstEntryId = await firstStore.getOrCreateEntryId("Notes/alpha.md");
    await firstStore.upsertEntry({
      entryId: firstEntryId,
      path: "Notes/alpha.md",
      revision: 0,
      blobId: "blob-alpha",
      hash: "hash-alpha",
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: null,
    });
    const repeatedEntryId = await firstStore.getOrCreateEntryId("Notes/alpha.md");

    expect(repeatedEntryId).toBe(firstEntryId);
    await firstStore.close();

    const reopenedStore = await createDexieSyncStore(plugin);
    const reloadedEntry = await reopenedStore.getEntryByPath("Notes/alpha.md");

    expect(reloadedEntry?.entryId).toBe(firstEntryId);
    expect(reloadedEntry?.revision).toBe(0);
    expect(reloadedEntry?.deleted).toBe(false);
    await reopenedStore.close();
  });

  it("persists entries and sync connection across reopen", async () => {
    const plugin = createPlugin();

    const store = await createDexieSyncStore(plugin);
    const localVaultId = await store.readLocalVaultId();
    await store.upsertEntry({
      entryId: "entry-1",
      path: "Notes/dexie.md",
      revision: 2,
      blobId: "blob-2",
      hash: "hash-2",
      deleted: false,
      updatedAt: 123,
      localMtime: null,
      localSize: null,
    });
    await store.writeSyncConnection({
      localVaultId,
      remoteVaultId: "remote-vault-1",
      lastPulledCursor: 0,
    });
    await store.setCursor(9);
    await store.close();

    const reopenedStore = await createDexieSyncStore(plugin);
    expect(await reopenedStore.readLocalVaultId()).toBe(localVaultId);
    expect(await reopenedStore.getEntryByPath("Notes/dexie.md")).toMatchObject({
      path: "Notes/dexie.md",
      revision: 2,
      blobId: "blob-2",
      hash: "hash-2",
      deleted: false,
      updatedAt: 123,
    });
    expect(await reopenedStore.readSyncConnection()).toEqual({
      localVaultId,
      remoteVaultId: "remote-vault-1",
      lastPulledCursor: 9,
    });
    await reopenedStore.close();
  });

  it("stores the local sync identity across reopen", async () => {
    const plugin = createPlugin();

    const firstStore = await createDexieSyncStore(plugin);
    const localVaultId = await firstStore.readLocalVaultId();
    expect(await firstStore.readSyncConnection()).toBeNull();
    await firstStore.writeSyncConnection({
      localVaultId: ` ${localVaultId} `,
      remoteVaultId: " remote-vault-1 ",
      lastPulledCursor: 0,
    });
    await firstStore.close();

    const reopenedStore = await createDexieSyncStore(plugin);
    expect(await reopenedStore.readSyncConnection()).toEqual({
      localVaultId,
      remoteVaultId: "remote-vault-1",
      lastPulledCursor: 0,
    });
    await reopenedStore.close();
  });

  it("reads a persisted identity without creating a long-lived store", async () => {
    const plugin = createPlugin();

    expect(await readDexieSyncStoreConnection(plugin)).toBeNull();

    const store = await createDexieSyncStore(plugin);
    const localVaultId = await store.readLocalVaultId();
    await store.writeSyncConnection({
      localVaultId,
      remoteVaultId: "remote-vault-1",
      lastPulledCursor: 0,
    });
    await store.close();

    expect(await readDexieSyncStoreConnection(plugin)).toEqual({
      localVaultId,
      remoteVaultId: "remote-vault-1",
      lastPulledCursor: 0,
    });
  });

  it("stores cursors and pending mutations across reopen", async () => {
    const plugin = createPlugin();

    const firstStore = await createDexieSyncStore(plugin);
    const localVaultId = await firstStore.readLocalVaultId();
    await firstStore.writeSyncConnection({
      localVaultId,
      remoteVaultId: "remote-vault-1",
      lastPulledCursor: 0,
    });
    const entryId = await firstStore.getOrCreateEntryId("Notes/beta.md");
    await firstStore.upsertEntry({
      entryId,
      path: "Notes/beta.md",
      revision: 3,
      blobId: "blob-3",
      hash: "hash-3",
      deleted: false,
      updatedAt: 123,
      localMtime: null,
      localSize: null,
    });
    await firstStore.setCursor(42);
    await firstStore.markEntryDirty({
      mutationId: "mutation-1",
      entryId,
      op: "upsert",
      baseRevision: 3,
      baseBlobId: "blob-3",
      baseHash: "hash-3",
      blobId: "blob-4",
      hash: "hash-4",
      encryptedMetadata: "ciphertext-4",
      createdAt: 500,
    });
    await firstStore.putBlob({
      blobId: "blob-3",
      hash: "hash-3",
      encryptedBytes: new Uint8Array([1, 2, 3]),
      cachedAt: 501,
    });
    await firstStore.close();

    const reopenedStore = await createDexieSyncStore(plugin);
    expect(await reopenedStore.getCursor()).toBe(42);

    const reloadedEntry = await reopenedStore.getEntryById(entryId);
    expect(reloadedEntry).toEqual({
      entryId,
      path: "Notes/beta.md",
      revision: 3,
      blobId: "blob-3",
      hash: "hash-3",
      deleted: false,
      updatedAt: 123,
      localMtime: null,
      localSize: null,
    });

    const pending = await reopenedStore.listDirtyEntries();
    expect(pending).toEqual([
      {
        mutationId: "mutation-1",
        entryId,
        op: "upsert",
        baseRevision: 3,
        baseBlobId: "blob-3",
        baseHash: "hash-3",
        blobId: "blob-4",
        hash: "hash-4",
        encryptedMetadata: "ciphertext-4",
        createdAt: 500,
      },
    ]);
    expect(await reopenedStore.getBlob("blob-3")).toEqual({
      blobId: "blob-3",
      hash: "hash-3",
      encryptedBytes: new Uint8Array([1, 2, 3]),
      cachedAt: 501,
    });
    expect(await reopenedStore.getEntryStateById(entryId)).toMatchObject({
      entryId,
      remote: {
        revision: 3,
        blobId: "blob-3",
        hash: "hash-3",
      },
      base: {
        revision: 3,
        blobId: "blob-3",
        hash: "hash-3",
      },
      local: {
        blobId: "blob-3",
        hash: "hash-3",
      },
      dirty: {
        mutationId: "mutation-1",
        baseBlobId: "blob-3",
        blobId: "blob-4",
      },
    });

    await reopenedStore.clearDirtyEntryByMutationId("mutation-1");
    expect(await reopenedStore.listDirtyEntries()).toEqual([]);
    await reopenedStore.close();
  });

  it("lists pending mutations by indexed queue order and clears by mutation id", async () => {
    const plugin = createPlugin();
    const store = await createDexieSyncStore(plugin);

    for (const input of [
      { mutationId: "mutation-late", entryId: "entry-late", createdAt: 30 },
      { mutationId: "mutation-early", entryId: "entry-early", createdAt: 10 },
      { mutationId: "mutation-middle", entryId: "entry-middle", createdAt: 20 },
    ]) {
      await store.markEntryDirty({
        mutationId: input.mutationId,
        entryId: input.entryId,
        op: "delete",
        baseRevision: 1,
        blobId: null,
        hash: null,
        encryptedMetadata: `ciphertext-${input.mutationId}`,
        createdAt: input.createdAt,
      });
    }

    expect((await store.listDirtyEntries(2)).map((entry) => entry.mutationId)).toEqual([
      "mutation-early",
      "mutation-middle",
    ]);

    await store.clearDirtyEntryByMutationId("mutation-middle");

    expect((await store.listDirtyEntries()).map((entry) => entry.mutationId)).toEqual([
      "mutation-early",
      "mutation-late",
    ]);
    await store.close();
  });

  it("keeps the current dirty mutation when replacement base validation fails", async () => {
    const plugin = createPlugin();
    const store = await createDexieSyncStore(plugin);

    await store.upsertEntry({
      entryId: "entry-1",
      path: "Notes/base.md",
      revision: 3,
      blobId: "blob-3",
      hash: "hash-3",
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: null,
    });
    await store.markEntryDirty({
      mutationId: "mutation-existing",
      entryId: "entry-1",
      op: "upsert",
      baseRevision: 3,
      baseBlobId: "blob-3",
      baseHash: "hash-3",
      blobId: "blob-existing",
      hash: "hash-existing",
      encryptedMetadata: "ciphertext-existing",
      createdAt: 2,
    });

    await expect(
      replacePendingMutationForEntry(store, {
        entryId: "entry-1",
        op: "upsert",
        baseRevision: 3,
        baseBlobId: "blob-missing",
        baseHash: "hash-missing",
        blobId: "blob-next",
        hash: "hash-next",
        encryptedMetadata: "ciphertext-next",
        createdAt: 3,
        requireBaseBlob: true,
      }),
    ).rejects.toThrow("requires cached base blob blob-missing");

    expect(await store.getDirtyEntryMutation("entry-1")).toMatchObject({
      mutationId: "mutation-existing",
      blobId: "blob-existing",
      hash: "hash-existing",
    });
    await store.close();
  });

  it("counts progress without materializing store rows", async () => {
    const plugin = createPlugin();
    const store = await createDexieSyncStore(plugin);

    await store.upsertEntry({
      entryId: "entry-synced",
      path: "Notes/synced.md",
      revision: 2,
      blobId: "blob-synced",
      hash: "hash-synced",
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: null,
    });
    await store.upsertEntry({
      entryId: "entry-pending",
      path: "Notes/pending.md",
      revision: 3,
      blobId: "blob-pending",
      hash: "hash-pending",
      deleted: false,
      updatedAt: 2,
      localMtime: null,
      localSize: null,
    });
    await store.upsertEntry({
      entryId: "entry-new",
      path: "Notes/new.md",
      revision: 0,
      blobId: "blob-new",
      hash: "hash-new",
      deleted: false,
      updatedAt: 3,
      localMtime: null,
      localSize: null,
    });
    await store.upsertEntry({
      entryId: "entry-deleted",
      path: null,
      revision: 4,
      blobId: null,
      hash: null,
      deleted: true,
      updatedAt: 4,
      localMtime: null,
      localSize: null,
    });
    await store.upsertEntry({
      entryId: "entry-delete-pending",
      path: null,
      revision: 5,
      blobId: null,
      hash: null,
      deleted: true,
      updatedAt: 5,
      localMtime: null,
      localSize: null,
    });
    await store.markEntryDirty({
      mutationId: "mutation-pending",
      entryId: "entry-pending",
      op: "upsert",
      baseRevision: 3,
      blobId: "blob-pending-next",
      hash: "hash-pending-next",
      encryptedMetadata: "ciphertext-pending",
      createdAt: 10,
    });
    await store.markEntryDirty({
      mutationId: "mutation-delete-pending",
      entryId: "entry-delete-pending",
      op: "delete",
      baseRevision: 5,
      blobId: null,
      hash: null,
      encryptedMetadata: "ciphertext-delete-pending",
      createdAt: 11,
    });

    const dexieStore = store as unknown as {
      db: { entries: { toArray: () => Promise<unknown[]> } };
    };
    const originalToArray = dexieStore.db.entries.toArray.bind(dexieStore.db.entries);
    let fullEntryScans = 0;
    dexieStore.db.entries.toArray = async () => {
      fullEntryScans += 1;
      return await originalToArray();
    };

    expect(await store.countSyncProgress()).toEqual({
      completedEntries: 1,
      totalEntries: 4,
    });
    expect(fullEntryScans).toBe(0);

    await store.clearDirtyEntryByMutationId("mutation-pending");
    expect(await store.countSyncProgress()).toEqual({
      completedEntries: 2,
      totalEntries: 4,
    });
    expect(fullEntryScans).toBe(0);
    await store.close();
  });

  it("lists synced deleted entries without treating tombstone paths as owners", async () => {
    const plugin = createPlugin();
    const store = await createDexieSyncStore(plugin);

    await store.upsertEntry({
      entryId: "entry-deleted",
      path: "Notes/deleted.md",
      revision: 4,
      blobId: null,
      hash: null,
      deleted: true,
      updatedAt: 40,
      localMtime: null,
      localSize: null,
    });
    await store.markEntryDirty({
      mutationId: "mutation-delete",
      entryId: "entry-deleted",
      op: "delete",
      baseRevision: 4,
      blobId: null,
      hash: null,
      encryptedMetadata: "ciphertext-delete",
      createdAt: 50,
    });

    expect(await store.getEntryByPath("Notes/deleted.md")).toBeNull();
    expect(await store.getOrCreateEntryId("Notes/deleted.md")).not.toBe(
      "entry-deleted",
    );
    await store.close();
  });

  it("deletes the persisted sync database and stored connection", async () => {
    const plugin = createPlugin();
    const firstStore = await createDexieSyncStore(plugin);
    const localVaultId = await firstStore.readLocalVaultId();
    await firstStore.upsertEntry({
      entryId: "entry-1",
      path: "Notes/reset.md",
      revision: 2,
      blobId: "blob-2",
      hash: "hash-2",
      deleted: false,
      updatedAt: 123,
      localMtime: null,
      localSize: null,
    });
    await firstStore.writeSyncConnection({
      localVaultId,
      remoteVaultId: "remote-vault-reset",
      lastPulledCursor: 0,
    });
    await firstStore.setCursor(9);
    await firstStore.close();

    await clearDexieSyncStore(plugin);

    const resetStore = await createDexieSyncStore(plugin);
    expect(await resetStore.listEntries()).toEqual([]);
    expect(await resetStore.getCursor()).toBe(0);
    expect(await resetStore.readSyncConnection()).toBeNull();
    await resetStore.close();
  });
});

type TestPlugin = Plugin & {
  localStorageValues: Map<string, unknown>;
};

function createPlugin(): TestPlugin {
  const localStorageValues = new Map<string, unknown>();

  return {
    manifest: {
      dir: ".obsidian/plugins/synch",
    },
    app: {
      loadLocalStorage(key: string): unknown {
        return localStorageValues.get(key) ?? null;
      },
      saveLocalStorage(key: string, value: unknown): void {
        if (value === null) {
          localStorageValues.delete(key);
          return;
        }

        localStorageValues.set(key, value);
      },
    },
    async loadData(): Promise<unknown> {
      return null;
    },
    async saveData(_value: unknown): Promise<void> {
      throw new Error("dexie sync store should not write plugin data");
    },
    localStorageValues,
  } as unknown as TestPlugin;
}
