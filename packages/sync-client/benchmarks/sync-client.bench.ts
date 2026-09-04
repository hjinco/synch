import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, bench, describe } from "vitest";

import {
  DEFAULT_SYNC_FILE_RULES,
  DEFAULT_VAULT_CONFIG_SYNC_RULES,
  SyncEngine,
  hashBytes,
  type HttpRequestInput,
  type HttpResponseLike,
  type SyncEngineDeps,
  type SyncVaultAdapter,
} from "../src/index";
import {
  loadBenchmarkFixture,
  type BenchmarkFixture,
  type BenchmarkFixtureEntry,
} from "./benchmark-fixture";
import { createBenchmarkVault } from "./benchmark-vault";
import {
  createTestSyncStore,
  type InMemorySyncStore,
} from "../src/test-support/in-memory-sync-store";

const API_BASE_URL = "http://sync-client-benchmark.local";
const CONFIG_DIR = ".obsidian";
const LOCAL_VAULT_ID = "benchmark-local-vault";
const REMOTE_VAULT_ID = "vault-1";
const REMOTE_VAULT_KEY = new Uint8Array(
  Array.from({ length: 32 }, (_, index) => index + 1),
);

const BENCHMARK_ITERATIONS = 5;
const WARMUP_ITERATIONS = 1;

const BENCHMARK_FILE_RULES = {
  ...DEFAULT_SYNC_FILE_RULES,
  includeOtherFiles: true,
};

type BenchmarkRemoteState = {
  entryId: string;
  revision: number;
  blobId: string | null;
  encryptedMetadata: string;
  deleted: boolean;
  updatedSeq: number;
  updatedAt: number;
};

type BenchmarkCommitMutation = {
  mutationId: string;
  entryId: string;
  op: "upsert" | "delete";
  baseRevision: number;
  blobId: string | null;
  encryptedMetadata: string;
};

type BenchmarkRun = {
  run(): Promise<void>;
  verifyAndDispose(): Promise<void>;
};

let fixturePromise: Promise<BenchmarkFixture> | null = null;
let benchmarkCleanupPromise: Promise<void> = Promise.resolve();

/**
 * The timed boundary is SyncEngine. The fake server only implements the
 * transport protocol needed by the public façade, while the vault reads and
 * writes the persistent local fixture through the filesystem.
 */
class BenchmarkServer {
  private readonly entries = new Map<string, BenchmarkRemoteState>();
  private readonly blobFiles = new Map<string, string>();
  private uploadDirectoryPromise: Promise<string> | null = null;
  private cursor: number;

  constructor(entries: BenchmarkFixtureEntry[] = [], cursor = 0) {
    this.cursor = cursor;
    for (const entry of entries) {
      this.entries.set(entry.entryId, toRemoteState(entry));
      this.blobFiles.set(entry.blobId, entry.encryptedBlobPath);
    }
  }

  get serverCursor(): number {
    return this.cursor;
  }

  get remoteEntries(): BenchmarkRemoteState[] {
    return [...this.entries.values()].sort(compareRemoteStates);
  }

  createWebSocket(): WebSocket {
    return new BenchmarkWebSocket(this) as unknown as WebSocket;
  }

  async requestHttp(input: HttpRequestInput): Promise<HttpResponseLike> {
    const marker = "/blobs/";
    const markerIndex = input.url.indexOf(marker);
    if (markerIndex < 0) {
      return { status: 404 };
    }

    const blobId = decodeURIComponent(input.url.slice(markerIndex + marker.length));
    if (input.method === "PUT") {
      if (!(input.body instanceof ArrayBuffer)) {
        return { status: 400 };
      }
      const uploadDirectory = await this.getUploadDirectory();
      const blobPath = join(uploadDirectory, `${blobId}.bin`);
      await writeFile(blobPath, new Uint8Array(input.body));
      this.blobFiles.set(blobId, blobPath);
      return { status: 200 };
    }

    const blobPath = this.blobFiles.get(blobId);
    if (!blobPath) {
      return { status: 404 };
    }
    const bytes = new Uint8Array(await readFile(blobPath));
    return { status: 200, arrayBuffer: bytes.slice().buffer as ArrayBuffer };
  }

  async handleMessage(
    message: Record<string, unknown>,
    socket: BenchmarkWebSocket,
  ): Promise<void> {
    const requestId = typeof message.requestId === "string" ? message.requestId : "";

    switch (message.type) {
      case "hello":
        socket.receive({
          type: "hello_ack",
          requestId,
          cursor: this.cursor,
          policy: {
            storageLimitBytes: 2 * 1024 * 1024 * 1024,
            maxFileSizeBytes: 2 * 1024 * 1024 * 1024,
          },
          storageStatus: {
            storageUsedBytes: 0,
            storageLimitBytes: 2 * 1024 * 1024 * 1024,
          },
          presenceSupported: false,
        });
        return;

      case "list_entry_states":
        socket.receive({
          type: "entry_states_listed",
          requestId,
          ...this.listEntryStates(message),
        });
        return;

      case "commit_mutations":
        socket.receive({
          type: "commit_mutations_committed",
          requestId,
          ...this.commitMutations(message),
        });
        return;

      case "heartbeat":
        socket.receive({ type: "heartbeat_ack", requestId });
        return;

      default:
        // Watch and presence messages are fire-and-forget for this harness.
        return;
    }
  }

  async dispose(): Promise<void> {
    const uploadDirectory = await this.uploadDirectoryPromise;
    if (uploadDirectory) {
      await rm(uploadDirectory, { recursive: true, force: true });
    }
  }

  private async getUploadDirectory(): Promise<string> {
    this.uploadDirectoryPromise ??= mkdtemp(
      join(tmpdir(), "synch-sync-client-blobs-"),
    );
    const uploadDirectory = this.uploadDirectoryPromise;
    return await uploadDirectory;
  }

  private listEntryStates(message: Record<string, unknown>): {
    targetCursor: number;
    totalEntries: number;
    hasMore: boolean;
    nextAfter: { updatedSeq: number; entryId: string } | null;
    entries: BenchmarkRemoteState[];
  } {
    const sinceCursor = asNumber(message.sinceCursor);
    const requestedTargetCursor = asNullableNumber(message.targetCursor);
    const targetCursor = requestedTargetCursor ?? this.cursor;
    const after = asCursor(message.after);
    const candidates = this.remoteEntries.filter(
      (entry) => entry.updatedSeq > sinceCursor && entry.updatedSeq <= targetCursor,
    );
    const startIndex = after
      ? candidates.findIndex((entry) => compareRemoteStates(entry, after) > 0)
      : 0;
    const safeStartIndex = startIndex < 0 ? candidates.length : startIndex;
    const entries = candidates.slice(safeStartIndex, safeStartIndex + 100);
    const last = entries[entries.length - 1];

    return {
      targetCursor,
      totalEntries: candidates.length,
      hasMore: safeStartIndex + entries.length < candidates.length,
      nextAfter: last
        ? { updatedSeq: last.updatedSeq, entryId: last.entryId }
        : null,
      entries,
    };
  }

  private commitMutations(message: Record<string, unknown>): {
    cursor: number;
    results: Array<{
      status: "accepted";
      mutationId: string;
      cursor: number;
      entryId: string;
      revision: number;
    }>;
  } {
    const mutations = Array.isArray(message.mutations)
      ? (message.mutations as BenchmarkCommitMutation[])
      : [];
    const results: Array<{
      status: "accepted";
      mutationId: string;
      cursor: number;
      entryId: string;
      revision: number;
    }> = [];

    for (const mutation of mutations) {
      this.cursor += 1;
      const previous = this.entries.get(mutation.entryId);
      const revision = Math.max(previous?.revision ?? 0, mutation.baseRevision) + 1;
      this.entries.set(mutation.entryId, {
        entryId: mutation.entryId,
        revision,
        blobId: mutation.op === "delete" ? null : mutation.blobId,
        encryptedMetadata: mutation.encryptedMetadata,
        deleted: mutation.op === "delete",
        updatedSeq: this.cursor,
        updatedAt: this.cursor,
      });
      results.push({
        status: "accepted",
        mutationId: mutation.mutationId,
        cursor: this.cursor,
        entryId: mutation.entryId,
        revision,
      });
    }

    return { cursor: this.cursor, results };
  }
}

class BenchmarkWebSocket {
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  constructor(private readonly server: BenchmarkServer) {
    queueMicrotask(() => this.emit("open", {}));
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
  ): void {
    if (!listener) return;
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
  ): void {
    if (!listener) return;
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    void this.server.handleMessage(JSON.parse(data) as Record<string, unknown>, this);
  }

  close(): void {
    this.emit("close", { code: 1000, reason: "" });
  }

  receive(message: Record<string, unknown>): void {
    queueMicrotask(() => this.emit("message", { data: JSON.stringify(message) }));
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === "function") {
        listener(event as Event);
      } else {
        listener.handleEvent(event as Event);
      }
    }
  }
}

describe("sync-client black-box scenarios", () => {
  registerScenario("initial-pull-1GiB", createInitialPullRun);
  registerScenario("incremental-pull-64MiB", createIncrementalPullRun);
  registerScenario("push-1GiB", createPushRun);
});

function registerScenario(
  name: string,
  createRun: (fixture: BenchmarkFixture) => Promise<BenchmarkRun>,
): void {
  let pendingRuns: BenchmarkRun[] = [];
  let completedRuns: BenchmarkRun[] = [];

  bench(
    name,
    async () => {
      const currentRun = pendingRuns.shift();
      if (!currentRun) {
        throw new Error("benchmark environment was not initialized");
      }
      completedRuns.push(currentRun);
      await currentRun.run();
    },
    {
      time: 0,
      iterations: BENCHMARK_ITERATIONS,
      warmupTime: 0,
      warmupIterations: WARMUP_ITERATIONS,
      setup: async (_task, mode) => {
        await benchmarkCleanupPromise;
        const fixture = await getFixture();
        pendingRuns = [];
        completedRuns = [];
        const iterations = mode === "warmup" ? WARMUP_ITERATIONS : BENCHMARK_ITERATIONS;
        for (let index = 0; index < iterations; index += 1) {
          pendingRuns.push(await createRun(fixture));
        }
      },
      teardown: () => {
        const runs = [...completedRuns, ...pendingRuns];
        pendingRuns = [];
        completedRuns = [];
        benchmarkCleanupPromise = benchmarkCleanupPromise.then(async () => {
          for (const run of runs) {
            await run.verifyAndDispose();
          }
        });
        return benchmarkCleanupPromise;
      },
    },
  );
}

afterAll(async () => {
  await benchmarkCleanupPromise;
});

async function getFixture(): Promise<BenchmarkFixture> {
  fixturePromise ??= loadBenchmarkFixture();
  return await fixturePromise;
}

async function createInitialPullRun(
  fixture: BenchmarkFixture,
): Promise<BenchmarkRun> {
  const server = new BenchmarkServer(fixture.baseline, fixture.baseline.length);
  const vaultHandle = await createBenchmarkVault(null);
  const store = createTestSyncStore(LOCAL_VAULT_ID);
  const harness = createEngineHarness(server, vaultHandle.adapter, store);

  await harness.engine.startAutoSync();
  harness.releaseDeferredWork();

  return createRunWithCleanup(
    harness,
    vaultHandle.dispose,
    server.dispose.bind(server),
    async () => {
      await assertVaultMatches(vaultHandle.adapter, fixture.baseline);
      await assertStoreIsClean(store, server.serverCursor);
    },
  );
}

async function createIncrementalPullRun(
  fixture: BenchmarkFixture,
): Promise<BenchmarkRun> {
  const server = new BenchmarkServer(
    fixture.incremental,
    fixture.incrementalCursor,
  );
  const vaultHandle = await createBenchmarkVault(fixture.filesDirectory);
  const store = createTestSyncStore(LOCAL_VAULT_ID);
  for (const entry of fixture.baseline) {
    await store.upsertEntry({
      entryId: entry.entryId,
      path: entry.path,
      revision: 1,
      blobId: entry.blobId,
      hash: entry.hash,
      deleted: false,
      updatedAt: entry.updatedAt,
      localMtime: 1,
      localSize: entry.size,
    });
  }
  await store.setCursor(fixture.baseline.length);

  const harness = createEngineHarness(server, vaultHandle.adapter, store);
  await harness.engine.startAutoSync();
  harness.releaseDeferredWork();

  return createRunWithCleanup(
    harness,
    vaultHandle.dispose,
    server.dispose.bind(server),
    async () => {
      await assertVaultMatches(vaultHandle.adapter, fixture.incremental);
      await assertStoreIsClean(store, server.serverCursor);
    },
  );
}

async function createPushRun(fixture: BenchmarkFixture): Promise<BenchmarkRun> {
  const server = new BenchmarkServer();
  const vaultHandle = await createBenchmarkVault(fixture.filesDirectory);
  const store = createTestSyncStore(LOCAL_VAULT_ID);
  const harness = createEngineHarness(server, vaultHandle.adapter, store);

  // Local change detection is setup work. The timed operation starts with
  // the same pending-mutation state for every sample.
  await harness.engine.reconcileOnce();
  if ((await store.listDirtyEntries()).length !== fixture.baseline.length) {
    await harness.dispose();
    await vaultHandle.dispose();
    await server.dispose();
    throw new Error("push benchmark setup did not queue all fixture files");
  }
  await harness.engine.startAutoSync();
  harness.releaseDeferredWork();

  return createRunWithCleanup(
    harness,
    vaultHandle.dispose,
    server.dispose.bind(server),
    async () => {
      await assertVaultMatches(vaultHandle.adapter, fixture.baseline);
      await assertStoreIsClean(store, server.serverCursor);
      if (server.remoteEntries.length !== fixture.baseline.length) {
        throw new Error("push benchmark did not commit all fixture files");
      }
    },
  );
}

function createRunWithCleanup(
  harness: ReturnType<typeof createEngineHarness>,
  disposeVault: () => Promise<void>,
  disposeServer: () => Promise<void>,
  verify: () => Promise<void>,
): BenchmarkRun {
  return {
    run: async () => {
      await requireSuccessfulSync(harness.engine.syncNow());
    },
    verifyAndDispose: async () => {
      try {
        await verify();
      } finally {
        await harness.dispose();
        await disposeVault();
        await disposeServer();
      }
    },
  };
}

async function requireSuccessfulSync(result: Promise<boolean>): Promise<void> {
  if (!(await result)) {
    throw new Error("SyncEngine.syncNow() did not complete successfully");
  }
}

function createEngineHarness(
  server: BenchmarkServer,
  vault: SyncVaultAdapter,
  store: InMemorySyncStore,
): {
  engine: SyncEngine;
  releaseDeferredWork: () => void;
  dispose: () => Promise<void>;
} {
  let deferSyncWork = true;
  const engine = new SyncEngine({
    vaultAdapter: vault,
    vaultConfigSource: {
      listFiles: async () => [],
    },
    httpClient: {
      request: async (input) => await server.requestHttp(input),
    },
    changeSource: {
      start() {},
    },
    getConfigDir: () => CONFIG_DIR,
    createWebSocket: () => server.createWebSocket(),
    getApiBaseUrl: () => API_BASE_URL,
    getSyncToken: async () => ({
      token: "benchmark-sync-token",
      expiresAt: Number.MAX_SAFE_INTEGER,
      vaultId: REMOTE_VAULT_ID,
      localVaultId: LOCAL_VAULT_ID,
    }),
    invalidateSyncToken: () => {},
    getRemoteVaultKey: () => REMOTE_VAULT_KEY,
    getSyncFileRules: () => BENCHMARK_FILE_RULES,
    getVaultConfigSyncRules: () => DEFAULT_VAULT_CONFIG_SYNC_RULES,
    shouldDeferSyncWork: () => deferSyncWork,
    hasActiveRemoteVaultSession: () => true,
    diagnostics: createNoopDiagnostics(),
    onSyncError: async (error, phase) => {
      throw new Error(`benchmark sync error in ${phase}: ${String(error)}`);
    },
    notifySyncConflict: () => {},
    notifyRollbackDetected: () => {},
    setSyncProgress: () => {},
    setSyncStatus: () => {},
    setStorageStatus: () => {},
  } satisfies SyncEngineDeps);

  engine.setStore(store);

  return {
    engine,
    releaseDeferredWork: () => {
      deferSyncWork = false;
    },
    dispose: async () => {
      await engine.dispose();
      await store.close();
    },
  };
}

async function assertVaultMatches(
  vault: SyncVaultAdapter,
  entries: BenchmarkFixtureEntry[],
): Promise<void> {
  for (const entry of entries) {
    const bytes = await vault.readBytes(entry.path);
    const actualHash = await hashBytes(bytes);
    if (bytes.byteLength !== entry.size || actualHash !== entry.hash) {
      throw new Error(
        `benchmark vault content mismatch: ${entry.path} ` +
          `(expected ${entry.hash}, got ${actualHash}, size ${bytes.byteLength})`,
      );
    }
  }
}

async function assertStoreIsClean(
  store: InMemorySyncStore,
  expectedCursor: number,
): Promise<void> {
  const dirty = await store.listDirtyEntries();
  if (dirty.length > 0) {
    throw new Error(`benchmark left ${dirty.length} pending mutations`);
  }
  const cursor = await store.getCursor();
  if (cursor !== expectedCursor) {
    throw new Error(`benchmark cursor mismatch: expected ${expectedCursor}, got ${cursor}`);
  }
}

function createNoopDiagnostics(): SyncEngineDeps["diagnostics"] {
  return {
    record: () => {},
    recordError: () => {},
    clear: () => {},
    getSnapshot: () => ({ count: 0, text: "" }),
    subscribe: () => () => {},
  };
}

function toRemoteState(entry: BenchmarkFixtureEntry): BenchmarkRemoteState {
  return {
    entryId: entry.entryId,
    revision: entry.revision,
    blobId: entry.blobId,
    encryptedMetadata: entry.encryptedMetadata,
    deleted: false,
    updatedSeq: entry.updatedSeq,
    updatedAt: entry.updatedAt,
  };
}

function compareRemoteStates(
  left: Pick<BenchmarkRemoteState, "updatedSeq" | "entryId">,
  right: Pick<BenchmarkRemoteState, "updatedSeq" | "entryId">,
): number {
  return left.updatedSeq !== right.updatedSeq
    ? left.updatedSeq - right.updatedSeq
    : left.entryId.localeCompare(right.entryId);
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : asNumber(value);
}

function asCursor(
  value: unknown,
): { updatedSeq: number; entryId: string } | null {
  if (!value || typeof value !== "object") return null;
  const cursor = value as Record<string, unknown>;
  return typeof cursor.entryId === "string"
    ? { updatedSeq: asNumber(cursor.updatedSeq), entryId: cursor.entryId }
    : null;
}
