import { describe, expect, it, vi } from "vitest";

import type { HttpRequestInput, HttpResponseLike } from "../../http/request";
import { createTestSyncStore } from "../../test-support/in-memory-sync-store";
import { InMemoryVaultAdapter } from "../../test-support/in-memory-vault-adapter";
import { encodeUtf8, hashBytes } from "../core/content";
import { encryptSyncBlob } from "../core/crypto";
import { DEFAULT_SYNC_FILE_RULES } from "../core/file-rules";
import { DEFAULT_VAULT_CONFIG_SYNC_RULES } from "../core/vault-config-rules";
import { queueLocalUpsertMutation } from "../core/mutation-queue";
import { InMemorySyncDiagnostics } from "../diagnostics/in-memory";
import type { SyncTokenResponse } from "../remote/client";
import { SyncAutoLoop } from "../engine/auto-sync";
import type { SyncChangeSource, SyncChangeSourceContext } from "./change-source";
import { SyncEngine, type SyncEngineDeps } from "./sync-engine";

const TEST_VAULT_KEY = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1));
const CONFIG_DIR = ".obsidian";

describe("SyncEngine", () => {
  it("reports offline sync startup failures through status without a notice", async () => {
    const vault = new InMemoryVaultAdapter();
    vault.seedText("note.md", "body");
    const store = createTestSyncStore();
    const setSyncStatus = vi.fn();
    const onSyncError = vi.fn();
    const { engine } = createTestEngine(vault, {
      getSyncToken: async () => {
        throw new Error("offline");
      },
      setSyncStatus,
      onSyncError,
    });
    engine.setStore(store);

    await engine.startAutoSync();

    expect(setSyncStatus).not.toHaveBeenCalledWith("offline");
    expect(onSyncError).toHaveBeenCalledWith(expect.any(Error), "auto_sync");
    engine.stopAutoSync();
    await store.close();
  });

  it("lists file-size blocked files with decrypted paths and size metadata", async () => {
    const vault = new InMemoryVaultAdapter();
    vault.seedText("note.md", "body");
    const store = createTestSyncStore();
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
    const { engine } = createTestEngine(vault);
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
    const vault = new InMemoryVaultAdapter();
    vault.seedText("note.md", "body");
    const { engine } = createTestEngine(vault);

    await expect(engine.listFileSizeBlockedFiles()).resolves.toEqual([]);
  });

  it("uses the configured path policy for presence lookups", () => {
    const vault = new InMemoryVaultAdapter();
    const { engine } = createTestEngine(vault, {
      getSyncFileRules: () => ({
        ...DEFAULT_SYNC_FILE_RULES,
        excludedFolders: ["Private"],
      }),
    });

    expect(engine.shouldSyncPath("Private/note.md")).toBe(false);
    expect(engine.shouldSyncPath("Public/note.md")).toBe(true);
  });

  it("flushes a local change only after in-flight mutation work finishes", async () => {
    const firstRead = createDeferred<Uint8Array>();
    const vault = new InMemoryVaultAdapter();
    vault.seedText("note.md", "seed");
    vault.readBytes = async () => await firstRead.promise;
    const store = createTestSyncStore();
    const { engine, changeSource } = createTestEngine(vault);
    engine.setStore(store);
    engine.registerVaultEvents();
    const context = changeSource.requireContext();
    const flush = vi.spyOn(SyncAutoLoop.prototype, "flushDebouncedPush");
    const waitDrain = vi
      .spyOn(SyncAutoLoop.prototype, "waitForInFlightDrain")
      .mockResolvedValue();

    try {
      void context.runLocalMutationWork(async () => {
        const changed = await context.eventRecorder.recordUpsert(
          "note.md",
          await vault.readBytes("note.md"),
        );
        if (changed) {
          context.notifyLocalChange();
        }
      });
      await nextTask();
      expect(engine.hasInFlightSyncWork()).toBe(true);

      const wait = engine.flushDebouncedPushAndWaitForInFlight();
      await nextTask();
      expect(flush).not.toHaveBeenCalled();
      expect(waitDrain).not.toHaveBeenCalled();

      firstRead.resolve(encodeUtf8("seed"));
      await wait;
      expect(engine.hasInFlightSyncWork()).toBe(false);
      expect(flush).toHaveBeenCalledTimes(1);
      expect(waitDrain).toHaveBeenCalledTimes(1);
      expect(flush.mock.invocationCallOrder[0]).toBeLessThan(
        waitDrain.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
    } finally {
      flush.mockRestore();
      waitDrain.mockRestore();
      await store.close();
    }
  });

  it("does not let baseline progress overwrite an active pull", async () => {
    const vault = new InMemoryVaultAdapter();
    vault.seedText("note.md", "body");
    const store = createTestSyncStore();
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
    const { engine } = createTestEngine(vault, { setSyncProgress });
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
    const vault = new InMemoryVaultAdapter();
    vault.seedText("note.md", "body");
    const store = createTestSyncStore();
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
    const { engine } = createTestEngine(vault, { setSyncProgress });
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

  it("serializes change source recording behind an active reconcile", async () => {
    const firstRead = createDeferred<Uint8Array>();
    let readCalls = 0;
    const vault = new InMemoryVaultAdapter();
    vault.seedText("note.md", "seed");
    vault.readBytes = async () => {
      readCalls += 1;
      if (readCalls === 1) {
        return await firstRead.promise;
      }

      return encodeUtf8("new");
    };
    const store = createTestSyncStore();
    const { engine, changeSource } = createTestEngine(vault);
    engine.setStore(store);
    engine.registerVaultEvents();
    const context = changeSource.requireContext();

    const reconcilePromise = engine.reconcileOnce();
    await nextTask();
    void context.runLocalMutationWork(async () => {
      const changed = await context.eventRecorder.recordUpsert(
        "note.md",
        await vault.readBytes("note.md"),
      );
      if (changed) {
        context.notifyLocalChange();
      }
    });
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
    const vault = new InMemoryVaultAdapter();
    const store = createTestSyncStore();
    const remoteBytes = encodeUtf8("{\"theme\":\"remote\"}");
    const remoteHash = await hashBytes(remoteBytes);
    const encryptedBytes = await encryptSyncBlob(
      TEST_VAULT_KEY,
      remoteBytes,
      { blobId: "blob-config" },
    );
    vault.seedText(`${CONFIG_DIR}/app.json`, "{\"theme\":\"local\"}");
    await store.applyRemoteState({
      entryId: "entry-config",
      path: `${CONFIG_DIR}/app.json`,
      revision: 1,
      blobId: "blob-config",
      hash: remoteHash,
      deleted: false,
      updatedAt: 10,
    });
    const { engine, setHttpHandler } = createTestEngine(vault, {
      getVaultConfigSyncRules: () => ({
        ...DEFAULT_VAULT_CONFIG_SYNC_RULES,
        enabled: true,
      }),
      shouldDeferSyncWork: () => false,
    });
    setHttpHandler(async () => ({
      status: 200,
      arrayBuffer: toArrayBuffer(encryptedBytes),
    }));
    engine.setStore(store);

    await expect(engine.reapplyAllowedRemoteVaultConfig()).resolves.toBe(1);
    await engine.reconcileOnce();

    await expect(vault.readBytes(`${CONFIG_DIR}/app.json`)).resolves.toEqual(
      remoteBytes,
    );
    await expect(store.listDirtyEntries()).resolves.toEqual([]);
    await expect(store.getEntryById("entry-config")).resolves.toMatchObject({
      entryId: "entry-config",
      path: `${CONFIG_DIR}/app.json`,
      revision: 1,
      blobId: "blob-config",
      hash: remoteHash,
      deleted: false,
    });
    await store.close();
  });

  it("updates stale local vault config when reapplying a newer remote revision", async () => {
    const vault = new InMemoryVaultAdapter();
    const store = createTestSyncStore();
    const localBytes = encodeUtf8("{\"theme\":\"old\"}");
    const localHash = await hashBytes(localBytes);
    const remoteBytes = encodeUtf8("{\"theme\":\"new\"}");
    const remoteHash = await hashBytes(remoteBytes);
    const encryptedBytes = await encryptSyncBlob(
      TEST_VAULT_KEY,
      remoteBytes,
      { blobId: "blob-config-new" },
    );
    vault.seedFile(`${CONFIG_DIR}/app.json`, localBytes);
    await store.upsertEntry({
      entryId: "entry-config",
      path: `${CONFIG_DIR}/app.json`,
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
      path: `${CONFIG_DIR}/app.json`,
      revision: 2,
      blobId: "blob-config-new",
      hash: remoteHash,
      deleted: false,
      updatedAt: 20,
    });
    const { engine, setHttpHandler } = createTestEngine(vault, {
      getVaultConfigSyncRules: () => ({
        ...DEFAULT_VAULT_CONFIG_SYNC_RULES,
        enabled: true,
      }),
    });
    setHttpHandler(async () => ({
      status: 200,
      arrayBuffer: toArrayBuffer(encryptedBytes),
    }));
    engine.setStore(store);

    await expect(engine.reapplyAllowedRemoteVaultConfig()).resolves.toBe(1);

    await expect(vault.readBytes(`${CONFIG_DIR}/app.json`)).resolves.toEqual(
      remoteBytes,
    );
    await expect(store.getEntryById("entry-config")).resolves.toMatchObject({
      entryId: "entry-config",
      path: `${CONFIG_DIR}/app.json`,
      revision: 2,
      blobId: "blob-config-new",
      hash: remoteHash,
      deleted: false,
    });
    await store.close();
  });

  it("does not overwrite pending local vault config when reapplying remote config", async () => {
    const vault = new InMemoryVaultAdapter();
    const store = createTestSyncStore();
    const baseBytes = encodeUtf8("{\"theme\":\"base\"}");
    const localBytes = encodeUtf8("{\"theme\":\"local\"}");
    const remoteBytes = encodeUtf8("{\"theme\":\"remote\"}");
    const baseHash = await hashBytes(baseBytes);
    const localHash = await hashBytes(localBytes);
    const remoteHash = await hashBytes(remoteBytes);
    vault.seedFile(`${CONFIG_DIR}/app.json`, localBytes);
    await store.upsertEntry({
      entryId: "entry-config",
      path: `${CONFIG_DIR}/app.json`,
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
      path: `${CONFIG_DIR}/app.json`,
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
      path: `${CONFIG_DIR}/app.json`,
      blobId: queued.blobId,
      hash: localHash,
      deleted: false,
      updatedAt: 11,
      localMtime: null,
      localSize: null,
    });
    await store.applyRemoteState({
      entryId: "entry-config",
      path: `${CONFIG_DIR}/app.json`,
      revision: 2,
      blobId: "blob-config-remote",
      hash: remoteHash,
      deleted: false,
      updatedAt: 20,
    });
    const { engine } = createTestEngine(vault, {
      getVaultConfigSyncRules: () => ({
        ...DEFAULT_VAULT_CONFIG_SYNC_RULES,
        enabled: true,
      }),
    });
    engine.setStore(store);

    await expect(engine.reapplyAllowedRemoteVaultConfig()).resolves.toBe(0);

    await expect(vault.readBytes(`${CONFIG_DIR}/app.json`)).resolves.toEqual(
      localBytes,
    );
    await expect(store.getDirtyEntryMutation("entry-config")).resolves.toMatchObject({
      entryId: "entry-config",
      op: "upsert",
      hash: localHash,
    });
    await store.close();
  });
});

class TestSyncChangeSource implements SyncChangeSource {
  private context: SyncChangeSourceContext | null = null;

  start(context: SyncChangeSourceContext): void {
    this.context = context;
  }

  requireContext(): SyncChangeSourceContext {
    if (!this.context) {
      throw new Error("change source was not started");
    }

    return this.context;
  }
}

interface TestEngineContext {
  engine: SyncEngine;
  changeSource: TestSyncChangeSource;
  setHttpHandler: (
    handler: (input: HttpRequestInput) => Promise<HttpResponseLike>,
  ) => void;
}

function createTestEngine(
  vault: InMemoryVaultAdapter,
  overrides: Partial<SyncEngineDeps> = {},
): TestEngineContext {
  let httpHandler: (input: HttpRequestInput) => Promise<HttpResponseLike> =
    async () => {
      throw new Error("http mock is not configured");
    };
  const changeSource = new TestSyncChangeSource();
  const engine = new SyncEngine({
    vaultAdapter: vault,
    vaultConfigSource: {
      listFiles: () => vault.listFilesUnder(CONFIG_DIR),
    },
    httpClient: {
      request: (input) => httpHandler(input),
    },
    changeSource,
    getConfigDir: () => CONFIG_DIR,
    getApiBaseUrl: () => "http://127.0.0.1:8787",
    getSyncToken: async () => createToken(),
    invalidateSyncToken: vi.fn(),
    getRemoteVaultKey: () => TEST_VAULT_KEY,
    getSyncFileRules: () => DEFAULT_SYNC_FILE_RULES,
    getVaultConfigSyncRules: () => DEFAULT_VAULT_CONFIG_SYNC_RULES,
    shouldDeferSyncWork: () => false,
    hasActiveRemoteVaultSession: () => true,
    diagnostics: new InMemorySyncDiagnostics("test"),
    onSyncError: vi.fn(),
    notifySyncConflict: vi.fn(),
    notifyRollbackDetected: vi.fn(),
    setSyncProgress: vi.fn(),
    setSyncStatus: vi.fn(),
    setStorageStatus: vi.fn(),
    ...overrides,
  });

  return {
    engine,
    changeSource,
    setHttpHandler: (handler) => {
      httpHandler = handler;
    },
  };
}

function createToken(): SyncTokenResponse {
  return {
    token: "sync-token",
    expiresAt: 1_000,
    vaultId: "vault-1",
    localVaultId: "local-vault-1",
  };
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
