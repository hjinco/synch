import type { Plugin, TFile } from "obsidian";
import { TFile as ObsidianTFile } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setRequestUrlMock } from "obsidian";

import { encodeUtf8, hashBytes } from "../core/content";
import { encryptSyncBlob } from "../core/crypto";
import { DEFAULT_SYNC_FILE_RULES } from "../core/file-rules";
import { DEFAULT_VAULT_CONFIG_SYNC_RULES } from "../core/vault-config-rules";
import { queueLocalUpsertMutation } from "../core/mutation-queue";
import type { SyncTokenResponse } from "../remote/client";
import { createInitializedTestSyncStore } from "../../test-support/test-plugin";
import { SyncEngine } from "./engine";

type VaultEventCallback = (...args: unknown[]) => void;

const TEST_VAULT_KEY = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1));

describe("SyncEngine", () => {
  afterEach(() => {
    setRequestUrlMock(async () => {
      throw new Error("requestUrl mock is not configured");
    });
  });

  it("reports offline sync startup failures through status without a notice", async () => {
    const plugin = createPlugin({}, async () => encodeUtf8("body"));
    const store = await createInitializedTestSyncStore(plugin);
    const setSyncStatus = vi.fn();
    const notifyError = vi.fn();
    const engine = createEngine(plugin, {
      getSyncToken: async () => {
        throw new Error("offline");
      },
      setSyncStatus,
      notifyError,
    });
    engine.setStore(store);

    await engine.startAutoSync();

    expect(setSyncStatus).toHaveBeenCalledWith("offline");
    expect(notifyError).not.toHaveBeenCalled();
    engine.stopAutoSync();
    await store.close();
  });

  it("lists file-size blocked files with decrypted paths and size metadata", async () => {
    const plugin = createPlugin({}, async () => encodeUtf8("body"));
    const store = await createInitializedTestSyncStore(plugin);
    const fileSizeBlocked = await queueLocalUpsertMutation(store, {
      remoteVaultKey: TEST_VAULT_KEY,
      path: "Folder/large.md",
      entryId: "entry-large",
      base: null,
      hash: "hash-large",
    });
    await store.updateDirtyEntry({
      ...fileSizeBlocked.mutation,
      status: "blocked",
      blockedReason: "file_too_large",
      blockedEncryptedSizeBytes: 12_400_000,
      blockedMaxFileSizeBytes: 10_000_000,
    });
    const engine = createEngine(plugin);
    engine.setStore(store);

    await expect(engine.listFileSizeBlockedFiles()).resolves.toEqual([
      {
        path: "Folder/large.md",
        encryptedSizeBytes: 12_400_000,
        maxFileSizeBytes: 10_000_000,
      },
    ]);
    await store.close();
  });

  it("returns no file-size blocked files when the store is not initialized", async () => {
    const plugin = createPlugin({}, async () => encodeUtf8("body"));
    const engine = createEngine(plugin);

    await expect(engine.listFileSizeBlockedFiles()).resolves.toEqual([]);
  });

  it("does not let baseline progress overwrite an active pull", async () => {
    const plugin = createPlugin({}, async () => encodeUtf8("body"));
    const store = await createInitializedTestSyncStore(plugin);
    await store.upsertEntry({
      entryId: "entry-synced",
      path: "synced.md",
      revision: 1,
      blobId: "blob-synced",
      hash: "hash-synced",
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: null,
    });
    const setSyncProgress = vi.fn();
    const engine = createEngine(plugin, { setSyncProgress });
    engine.setStore(store);
    const activityEngine = engine as unknown as {
      withSyncActivity<T>(kind: "pull", work: () => Promise<T>): Promise<T>;
      reportActivityProgress(progress: {
        completedEntries: number;
        totalEntries: number;
      }): void;
    };

    await activityEngine.withSyncActivity("pull", async () => {
      activityEngine.reportActivityProgress({
        completedEntries: 0,
        totalEntries: 4000,
      });
      await engine.refreshSyncProgress();
      activityEngine.reportActivityProgress({
        completedEntries: 100,
        totalEntries: 4000,
      });
    });

    expect(setSyncProgress.mock.calls.map(([progress]) => progress)).toEqual([
      {
        completedEntries: 0,
        totalEntries: 4000,
      },
      {
        completedEntries: 100,
        totalEntries: 4000,
      },
      {
        completedEntries: 1,
        totalEntries: 1,
      },
    ]);
    await store.close();
  });

  it("keeps pull progress active when overlapping local work finishes first", async () => {
    const plugin = createPlugin({}, async () => encodeUtf8("body"));
    const store = await createInitializedTestSyncStore(plugin);
    await store.upsertEntry({
      entryId: "entry-synced",
      path: "synced.md",
      revision: 1,
      blobId: "blob-synced",
      hash: "hash-synced",
      deleted: false,
      updatedAt: 1,
      localMtime: null,
      localSize: null,
    });
    const setSyncProgress = vi.fn();
    const engine = createEngine(plugin, { setSyncProgress });
    engine.setStore(store);
    const activityEngine = engine as unknown as {
      withSyncActivity<T>(
        kind: "local" | "pull",
        work: () => Promise<T>,
      ): Promise<T>;
      reportActivityProgress(progress: {
        completedEntries: number;
        totalEntries: number;
      }): void;
    };
    const releaseLocal = createDeferred<void>();
    const releasePull = createDeferred<void>();

    const local = activityEngine.withSyncActivity("local", async () => {
      await releaseLocal.promise;
    });
    const pull = activityEngine.withSyncActivity("pull", async () => {
      activityEngine.reportActivityProgress({
        completedEntries: 0,
        totalEntries: 4000,
      });
      await releasePull.promise;
    });
    await nextTask();

    releaseLocal.resolve();
    await local;
    await engine.refreshSyncProgress();
    activityEngine.reportActivityProgress({
      completedEntries: 100,
      totalEntries: 4000,
    });
    releasePull.resolve();
    await pull;

    expect(setSyncProgress.mock.calls.map(([progress]) => progress)).toEqual([
      {
        completedEntries: 0,
        totalEntries: 4000,
      },
      {
        completedEntries: 100,
        totalEntries: 4000,
      },
      {
        completedEntries: 1,
        totalEntries: 1,
      },
    ]);
    await store.close();
  });

  it("serializes vault event recording behind an active reconcile", async () => {
    const firstRead = createDeferred<Uint8Array>();
    const callbacks: Partial<Record<"modify", VaultEventCallback>> = {};
    let readCalls = 0;
    const plugin = createPlugin(callbacks, async () => {
      readCalls += 1;
      if (readCalls === 1) {
        return await firstRead.promise;
      }

      return encodeUtf8("new");
    });
    const store = await createInitializedTestSyncStore(plugin);
    const engine = new SyncEngine({
      plugin,
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      invalidateSyncToken: vi.fn(),
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      getSyncFileRules: () => DEFAULT_SYNC_FILE_RULES,
      getVaultConfigSyncRules: () => DEFAULT_VAULT_CONFIG_SYNC_RULES,
      hasActiveRemoteVaultSession: () => true,
      notify: vi.fn(),
      notifyError: vi.fn(),
      notifySyncConflict: vi.fn(),
      setSyncProgress: vi.fn(),
      setSyncStatus: vi.fn(),
      setStorageStatus: vi.fn(),
    });
    engine.setStore(store);
    engine.registerVaultEvents();

    const reconcilePromise = engine.reconcileOnce();
    await nextTask();
    callbacks.modify?.(createFile("note.md"));
    await nextTask();

    expect(readCalls).toBe(1);

    firstRead.resolve(encodeUtf8("old"));
    await reconcilePromise;
    await eventually(async () => {
      expect(readCalls).toBe(2);
      const pending = await store.listDirtyEntries();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.hash).toBe(await hashBytes(encodeUtf8("new")));
    });
    await store.close();
  });

  it("reapplies previously skipped remote vault config before reconcile queues local writes", async () => {
    const plugin = createPlugin({}, async () => encodeUtf8("body"), []);
    const store = await createInitializedTestSyncStore(plugin);
    const remoteBytes = encodeUtf8("{\"theme\":\"remote\"}");
    const remoteHash = await hashBytes(remoteBytes);
    const encryptedBytes = await encryptSyncBlob(
      TEST_VAULT_KEY,
      remoteBytes,
      { blobId: "blob-config" },
      { syncFormatVersion: 1 },
    );
    await plugin.app.vault.adapter.write(".obsidian/app.json", "{\"theme\":\"local\"}");
    await store.applyRemoteState({
      entryId: "entry-config",
      path: ".obsidian/app.json",
      revision: 1,
      blobId: "blob-config",
      hash: remoteHash,
      deleted: false,
      updatedAt: 10,
    });
    setRequestUrlMock(async () => ({
      status: 200,
      arrayBuffer: toArrayBuffer(encryptedBytes),
    }));
    const engine = createEngine(plugin, {
      getVaultConfigSyncRules: () => ({
        ...DEFAULT_VAULT_CONFIG_SYNC_RULES,
        enabled: true,
      }),
    });
    engine.setStore(store);

    await expect(engine.reapplyAllowedRemoteVaultConfig()).resolves.toBe(1);
    await engine.reconcileOnce();

    await expect(
      plugin.app.vault.adapter.readBinary(".obsidian/app.json"),
    ).resolves.toEqual(toArrayBuffer(remoteBytes));
    await expect(store.listDirtyEntries()).resolves.toEqual([]);
    await expect(store.getEntryById("entry-config")).resolves.toMatchObject({
      entryId: "entry-config",
      path: ".obsidian/app.json",
      revision: 1,
      blobId: "blob-config",
      hash: remoteHash,
      deleted: false,
    });
    await store.close();
  });

  it("updates stale local vault config when reapplying a newer remote revision", async () => {
    const plugin = createPlugin({}, async () => encodeUtf8("body"), []);
    const store = await createInitializedTestSyncStore(plugin);
    const localBytes = encodeUtf8("{\"theme\":\"old\"}");
    const localHash = await hashBytes(localBytes);
    const remoteBytes = encodeUtf8("{\"theme\":\"new\"}");
    const remoteHash = await hashBytes(remoteBytes);
    const encryptedBytes = await encryptSyncBlob(
      TEST_VAULT_KEY,
      remoteBytes,
      { blobId: "blob-config-new" },
      { syncFormatVersion: 1 },
    );
    await plugin.app.vault.adapter.writeBinary(
      ".obsidian/app.json",
      toArrayBuffer(localBytes),
    );
    await store.upsertEntry({
      entryId: "entry-config",
      path: ".obsidian/app.json",
      revision: 1,
      blobId: "blob-config-old",
      hash: localHash,
      deleted: false,
      updatedAt: 10,
      localMtime: null,
      localSize: null,
    });
    await store.applyRemoteState({
      entryId: "entry-config",
      path: ".obsidian/app.json",
      revision: 2,
      blobId: "blob-config-new",
      hash: remoteHash,
      deleted: false,
      updatedAt: 20,
    });
    setRequestUrlMock(async () => ({
      status: 200,
      arrayBuffer: toArrayBuffer(encryptedBytes),
    }));
    const engine = createEngine(plugin, {
      getVaultConfigSyncRules: () => ({
        ...DEFAULT_VAULT_CONFIG_SYNC_RULES,
        enabled: true,
      }),
    });
    engine.setStore(store);

    await expect(engine.reapplyAllowedRemoteVaultConfig()).resolves.toBe(1);

    await expect(
      plugin.app.vault.adapter.readBinary(".obsidian/app.json"),
    ).resolves.toEqual(toArrayBuffer(remoteBytes));
    await expect(store.getEntryById("entry-config")).resolves.toMatchObject({
      entryId: "entry-config",
      path: ".obsidian/app.json",
      revision: 2,
      blobId: "blob-config-new",
      hash: remoteHash,
      deleted: false,
    });
    await store.close();
  });

  it("does not overwrite pending local vault config when reapplying remote config", async () => {
    const plugin = createPlugin({}, async () => encodeUtf8("body"), []);
    const store = await createInitializedTestSyncStore(plugin);
    const baseBytes = encodeUtf8("{\"theme\":\"base\"}");
    const localBytes = encodeUtf8("{\"theme\":\"local\"}");
    const remoteBytes = encodeUtf8("{\"theme\":\"remote\"}");
    const baseHash = await hashBytes(baseBytes);
    const localHash = await hashBytes(localBytes);
    const remoteHash = await hashBytes(remoteBytes);
    await plugin.app.vault.adapter.writeBinary(
      ".obsidian/app.json",
      toArrayBuffer(localBytes),
    );
    await store.upsertEntry({
      entryId: "entry-config",
      path: ".obsidian/app.json",
      revision: 1,
      blobId: "blob-config-base",
      hash: baseHash,
      deleted: false,
      updatedAt: 10,
      localMtime: null,
      localSize: null,
    });
    const queued = await queueLocalUpsertMutation(store, {
      remoteVaultKey: TEST_VAULT_KEY,
      path: ".obsidian/app.json",
      entryId: "entry-config",
      base: await store.getRemoteStateById("entry-config"),
      previousLocal: {
        deleted: false,
        blobId: "blob-config-base",
        hash: baseHash,
      },
      hash: localHash,
    });
    await store.applyLocalState({
      entryId: "entry-config",
      path: ".obsidian/app.json",
      blobId: queued.blobId,
      hash: localHash,
      deleted: false,
      updatedAt: 11,
      localMtime: null,
      localSize: null,
    });
    await store.applyRemoteState({
      entryId: "entry-config",
      path: ".obsidian/app.json",
      revision: 2,
      blobId: "blob-config-remote",
      hash: remoteHash,
      deleted: false,
      updatedAt: 20,
    });
    const engine = createEngine(plugin, {
      getVaultConfigSyncRules: () => ({
        ...DEFAULT_VAULT_CONFIG_SYNC_RULES,
        enabled: true,
      }),
    });
    engine.setStore(store);

    await expect(engine.reapplyAllowedRemoteVaultConfig()).resolves.toBe(0);

    await expect(
      plugin.app.vault.adapter.readBinary(".obsidian/app.json"),
    ).resolves.toEqual(toArrayBuffer(localBytes));
    await expect(store.getDirtyEntryMutation("entry-config")).resolves.toMatchObject({
      entryId: "entry-config",
      op: "upsert",
      hash: localHash,
    });
    await store.close();
  });

});

function createEngine(
  plugin: Plugin,
  overrides: Partial<SyncEngineDepsForTest> = {},
): SyncEngine {
  return new SyncEngine({
    plugin,
    getApiBaseUrl: () => "http://127.0.0.1:8787",
    getSyncToken: async () => createToken(),
    invalidateSyncToken: vi.fn(),
    getRemoteVaultKey: () => TEST_VAULT_KEY,
    getSyncFileRules: () => DEFAULT_SYNC_FILE_RULES,
    getVaultConfigSyncRules: () => DEFAULT_VAULT_CONFIG_SYNC_RULES,
    hasActiveRemoteVaultSession: () => true,
    notify: vi.fn(),
    notifyError: vi.fn(),
    notifySyncConflict: vi.fn(),
    setSyncProgress: vi.fn(),
    setSyncStatus: vi.fn(),
    setStorageStatus: vi.fn(),
    ...overrides,
  });
}

type SyncEngineDepsForTest = ConstructorParameters<typeof SyncEngine>[0];

function createPlugin(
  callbacks: Partial<Record<"modify", VaultEventCallback>>,
  readBinary: () => Promise<Uint8Array>,
  visibleFiles: TFile[] = [createFile("note.md")],
): Plugin {
  const localStorage = new Map<string, unknown>();
  const directories = new Set([".obsidian/plugins/synch"]);
  const files = new Map<string, string | Uint8Array>();

  return {
    manifest: {
      dir: ".obsidian/plugins/synch",
    },
    registerEvent: vi.fn(),
    app: {
      loadLocalStorage(key: string): unknown | null {
        return localStorage.get(key) ?? null;
      },
      saveLocalStorage(key: string, value: unknown | null): void {
        if (value === null) {
          localStorage.delete(key);
          return;
        }

        localStorage.set(key, value);
      },
      vault: {
        getFiles: vi.fn(() => visibleFiles),
        readBinary: vi.fn(async () => toArrayBuffer(await readBinary())),
        on: vi.fn((eventName: string, callback: VaultEventCallback) => {
          if (eventName === "modify") {
            callbacks.modify = callback;
          }
          return {};
        }),
        adapter: {
          async exists(path: string): Promise<boolean> {
            return directories.has(path) || files.has(path);
          },
          async read(path: string): Promise<string> {
            const file = files.get(path);
            if (typeof file !== "string") {
              throw new Error(`missing test file: ${path}`);
            }

            return file;
          },
          async readBinary(path: string): Promise<ArrayBuffer> {
            const file = files.get(path);
            if (!(file instanceof Uint8Array)) {
              throw new Error(`missing test file: ${path}`);
            }

            return toArrayBuffer(file);
          },
          async write(path: string, value: string): Promise<void> {
            files.set(path, value);
          },
          async writeBinary(path: string, value: ArrayBuffer): Promise<void> {
            files.set(path, new Uint8Array(value));
          },
          async remove(path: string): Promise<void> {
            files.delete(path);
          },
          async mkdir(path: string): Promise<void> {
            directories.add(path);
          },
          async stat(path: string): Promise<{
            type: "file" | "folder";
            mtime: number;
            size: number;
          } | null> {
            if (directories.has(path)) {
              return { type: "folder", mtime: 1, size: 0 };
            }
            const file = files.get(path);
            if (!file) {
              return null;
            }
            return {
              type: "file",
              mtime: 1,
              size: typeof file === "string" ? file.length : file.byteLength,
            };
          },
          async list(path: string): Promise<{ files: string[]; folders: string[] }> {
            const prefix = path ? `${path}/` : "";
            const childFiles: string[] = [];
            const childFolders = new Set<string>();
            for (const filePath of files.keys()) {
              if (!filePath.startsWith(prefix)) {
                continue;
              }
              const rest = filePath.slice(prefix.length);
              const separatorIndex = rest.indexOf("/");
              if (separatorIndex < 0) {
                childFiles.push(filePath);
              } else {
                childFolders.add(`${prefix}${rest.slice(0, separatorIndex)}`);
              }
            }
            for (const folderPath of directories) {
              if (!folderPath.startsWith(prefix) || folderPath === path) {
                continue;
              }
              const rest = folderPath.slice(prefix.length);
              const separatorIndex = rest.indexOf("/");
              childFolders.add(
                separatorIndex < 0
                  ? folderPath
                  : `${prefix}${rest.slice(0, separatorIndex)}`,
              );
            }
            return {
              files: childFiles.sort(),
              folders: [...childFolders].sort(),
            };
          },
        },
      },
    },
    async loadData(): Promise<unknown> {
      return null;
    },
    async saveData(): Promise<void> {},
  } as unknown as Plugin;
}

function createToken(): SyncTokenResponse {
  return {
    token: "sync-token",
    expiresAt: 1_000,
    vaultId: "vault-1",
    localVaultId: "local-vault-1",
    syncFormatVersion: 1,
  };
}

function createFile(path: string): TFile {
  const file = new ObsidianTFile(path) as TFile;
  file.stat = {
    ctime: 1,
    mtime: 1,
    size: 3,
  };
  return file;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((next) => {
    resolve = next;
  });

  return { promise, resolve };
}

async function eventually(assertion: () => Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await nextTask();
    }
  }

  throw lastError;
}

async function nextTask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
