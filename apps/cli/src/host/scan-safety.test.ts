import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  DEFAULT_SYNC_FILE_RULES,
  DEFAULT_VAULT_CONFIG_SYNC_RULES,
  SyncContentRuntime,
  hashBytes,
} from "@synch/sync-client/core";
import { SyncLocalReconcileService } from "../../../../packages/sync-client/src/sync/engine/local-reconcile-service";
import type { CliAppContext } from "../app/context";
import { runSync } from "../commands/sync";
import { SqliteSyncStore } from "./sqlite-store";
import { NodeSyncVaultAdapter } from "./vault-adapter";
import { NodeVaultConfigSource } from "./vault-config-source";

let temporary: string;
let vault: string;
let store: SqliteSyncStore;
let runtime: SyncContentRuntime;
let reconcile: SyncLocalReconcileService;

beforeEach(async () => {
  temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "synch-scan-safety-")));
  vault = path.join(temporary, "vault");
  fs.mkdirSync(vault);
  store = SqliteSyncStore.open(path.join(temporary, "sync.sqlite"));
  runtime = new SyncContentRuntime();
  const adapter = new NodeSyncVaultAdapter({
    vaultPath: vault,
    getConfigDir: () => ".obsidian",
    getSyncFileRules: () => DEFAULT_SYNC_FILE_RULES,
  });
  const config = new NodeVaultConfigSource({
    vaultPath: vault,
    getConfigDir: () => ".obsidian",
    getVaultConfigSyncRules: () => ({ ...DEFAULT_VAULT_CONFIG_SYNC_RULES, enabled: true }),
  });
  reconcile = new SyncLocalReconcileService({
    contentRuntime: runtime,
    getSyncStore: () => store,
    getRemoteVaultKey: () => new Uint8Array(32).fill(7),
    scanner: {
      isExcludedPath: (filePath) => adapter.isExcludedPath(filePath),
      listFiles: async () => [...await adapter.listFiles(), ...await config.listFiles()],
    },
    shouldSyncPath: (filePath) => adapter.isSyncablePath(filePath) || config.isSyncablePath(filePath),
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await store.close();
  await runtime.dispose();
  fs.rmSync(temporary, { recursive: true, force: true });
});

async function seedSynced(filePath: string) {
  const absolute = path.join(vault, filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, "original content");
  const stat = fs.statSync(absolute);
  await store.upsertEntry({
    entryId: filePath,
    path: filePath,
    revision: 1,
    blobId: `blob-${filePath}`,
    hash: await hashBytes(fs.readFileSync(absolute)),
    deleted: false,
    updatedAt: 1,
    localMtime: Math.floor(stat.mtimeMs),
    localSize: stat.size,
  });
  return absolute;
}

function command() {
  // Keep the real scan/reconcile and command ordering; fail if networking starts
  // after a failed scan. main.ts turns a rejected runSync into exit code 1.
  const startAutoSync = vi.fn(async () => {});
  const syncNow = vi.fn(async () => true);
  const log = vi.fn();
  const ctx = {
    vaultPath: vault,
    initializeAuth: async () => {},
    requireVerifiedAuth: () => {},
    openVaultSession: async () => {},
    logger: { log, error: vi.fn() },
    syncProgress: { completedEntries: 0, totalEntries: 0 },
    engine: {
      reconcileOnce: () => reconcile.reconcileOnce(),
      waitForLocalMutationWork: async () => {},
      startAutoSync,
      syncNow,
      hasPendingMutations: async () => (await store.listDirtyEntries()).length > 0,
      stopAutoSync: () => {},
    },
    takeLastSyncError: () => null,
  } as unknown as CliAppContext;
  return { run: () => runSync(ctx), startAutoSync, syncNow, log };
}

const paths = ["restricted/important.md", ".obsidian/app.json"];

// Real chmod is essential to cover the original report. Root bypasses these
// permissions; Linux CI runs as an ordinary user. Injected I/O tests below run
// on every platform, including root and Windows.
it.skipIf(process.platform === "win32" || process.getuid?.() === 0).each(
  paths.flatMap((filePath) => [0o000, 0o100].map((mode) => ({ filePath, mode }))),
)("aborts without uploading deletions for unreadable $filePath (mode $mode)", async ({ filePath, mode }) => {
  const original = await seedSynced(filePath);
  const removed = await seedSynced("removed.md");
  fs.unlinkSync(removed);
  fs.writeFileSync(path.join(vault, "new.md"), "new content");
  const before = await store.listReconcileEntryStates();
  const folder = path.dirname(original);
  const sync = command();
  fs.chmodSync(folder, mode);
  try {
    await expect(fsPromises.readdir(folder)).rejects.toMatchObject({ code: "EACCES" });
    await expect(sync.run()).rejects.toMatchObject({ code: "EACCES" });
    expect(sync.startAutoSync).not.toHaveBeenCalled();
    expect(sync.syncNow).not.toHaveBeenCalled();
    expect(sync.log).not.toHaveBeenCalledWith(expect.stringContaining("Sync complete"));
    expect(await store.listReconcileEntryStates()).toEqual(before);
    expect(await store.listDirtyEntries()).toEqual([]);
  } finally {
    fs.chmodSync(folder, 0o700);
  }

  expect(fs.readFileSync(original, "utf8")).toBe("original content");
  // Retrying after restoring access preserves the restricted file while
  // allowing unrelated real changes and deletions to synchronize.
  await expect(reconcile.reconcileOnce()).resolves.toMatchObject({
    filesQueuedForUpsert: 1,
    filesQueuedForDelete: 1,
  });
  expect(await store.getDirtyEntryMutation(filePath)).toBeNull();
  expect(await store.getDirtyEntryMutation("removed.md")).toMatchObject({ op: "delete" });
});

it.each(paths)("still queues deletions when the directory containing %s is removed", async (filePath) => {
  const original = await seedSynced(filePath);
  fs.rmSync(path.dirname(original), { recursive: true });
  await expect(reconcile.reconcileOnce()).resolves.toMatchObject({ filesQueuedForDelete: 1 });
  expect(await store.getDirtyEntryMutation(filePath)).toMatchObject({ op: "delete" });
});

it.each(paths.flatMap((filePath) => ["readdir", "stat"].map((operation) => ({ filePath, operation }))))(
  "preserves all state when $operation fails with EIO scanning $filePath",
  async ({ filePath, operation }) => {
    await seedSynced(filePath);
    fs.writeFileSync(path.join(vault, "new.md"), "new content");
    const before = await store.listReconcileEntryStates();
    const error = Object.assign(new Error("filesystem I/O failure"), { code: "EIO" });
    if (operation === "readdir") {
      const readdir = fsPromises.readdir.bind(fsPromises);
      vi.spyOn(fsPromises, "readdir").mockImplementation(async (directory, options) => {
        if (String(directory) === path.dirname(path.join(vault, filePath))) throw error;
        return readdir(directory, options);
      });
    } else {
      const stat = fsPromises.stat.bind(fsPromises);
      vi.spyOn(fsPromises, "stat").mockImplementation(async (file, options) => {
        if (String(file) === path.join(vault, filePath)) throw error;
        return stat(file, options);
      });
    }
    const sync = command();
    await expect(sync.run()).rejects.toBe(error);
    expect(sync.startAutoSync).not.toHaveBeenCalled();
    expect(sync.syncNow).not.toHaveBeenCalled();
    expect(await store.listReconcileEntryStates()).toEqual(before);
    expect(await store.listDirtyEntries()).toEqual([]);
  },
);
