import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, bench, describe } from "vitest";

import {
  DEFAULT_SYNC_FILE_RULES,
  DEFAULT_VAULT_CONFIG_SYNC_RULES,
  SyncEngine,
  hashBytes,
  createSyncCryptoContext,
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
import { PushMetrics } from "./push-metrics";
import { createMixedPushFixture, MIXED_PUSH_FIXTURE_SPEC } from "./mixed-push-fixture";
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
  metrics?: PushMetrics;
};

type TransportProfile = {
  uploadDelayMs: number;
  commitDelayMs: number;
  attachmentExtraDelayMs: number;
};
const NO_DELAY: TransportProfile = {
  uploadDelayMs: 0,
  commitDelayMs: 0,
  attachmentExtraDelayMs: 0,
};
const MIXED_PROFILES: Record<string, TransportProfile> = {
  "push-mixed-no-delay": NO_DELAY,
  "push-mixed-latency": {
    uploadDelayMs: 40,
    commitDelayMs: 40,
    attachmentExtraDelayMs: 0,
  },
  "push-mixed-slow-attachment": {
    uploadDelayMs: 40,
    commitDelayMs: 40,
    attachmentExtraDelayMs: 800,
  },
};
const measurements: Record<string, ReturnType<PushMetrics["snapshot"]>[]> = {};

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

  constructor(
    entries: BenchmarkFixtureEntry[] = [],
    cursor = 0,
    private readonly profile: TransportProfile = NO_DELAY,
    private readonly metrics?: PushMetrics,
  ) {
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
      this.metrics?.uploadStarted(input.body.byteLength);
      const isAttachment = input.body.byteLength >= MIXED_PUSH_FIXTURE_SPEC.attachmentBytes;
      const uploadDelayMs = this.profile.uploadDelayMs +
        (isAttachment ? this.profile.attachmentExtraDelayMs : 0);
      if (uploadDelayMs > 0) await delay(uploadDelayMs);
      const uploadDirectory = await this.getUploadDirectory();
      const blobPath = join(uploadDirectory, `${blobId}.bin`);
      await writeFile(blobPath, new Uint8Array(input.body));
      this.blobFiles.set(blobId, blobPath);
      if (isAttachment) this.metrics?.slowUploadCompleted();
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
        this.metrics?.commitStarted();
        if (this.profile.commitDelayMs > 0) await delay(this.profile.commitDelayMs);
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

  async assertUploadedContents(expected: Map<string, { size: number; hash: string }>): Promise<void> {
    const crypto = createSyncCryptoContext(REMOTE_VAULT_KEY);
    try {
      if (this.entries.size !== expected.size) throw new Error("Remote entry count mismatch");
      for (const [entryId, content] of expected) {
        const entry = this.entries.get(entryId);
        const blobPath = entry?.blobId ? this.blobFiles.get(entry.blobId) : null;
        if (!entry?.blobId || !blobPath) throw new Error("Committed blob is missing");
        const plaintext = await crypto.decryptBlob(new Uint8Array(await readFile(blobPath)), {
          blobId: entry.blobId,
        });
        if (plaintext.byteLength !== content.size || await hashBytes(plaintext) !== content.hash) {
          throw new Error("Uploaded content mismatch");
        }
      }
    } finally {
      crypto.dispose();
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

    if (results.length) this.metrics?.committed();
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
  registerScenario("initial-pull-1GiB", async () => createInitialPullRun(await getFixture()));
  registerScenario("incremental-pull-64MiB", async () => createIncrementalPullRun(await getFixture()));
  registerScenario("push-1GiB", async () => createPushRun(await getFixture()));
  for (const [name, profile] of Object.entries(MIXED_PROFILES)) {
    registerScenario(name, () => createMixedPushRun(profile));
  }
});

function registerScenario(
  name: string,
  createRun: () => Promise<BenchmarkRun>,
): void {
  let pendingRuns: BenchmarkRun[] = [];
  let completedRuns: BenchmarkRun[] = [];
  let measured = false;

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
        measured = mode !== "warmup";
        pendingRuns = [];
        completedRuns = [];
        const iterations = mode === "warmup" ? WARMUP_ITERATIONS : BENCHMARK_ITERATIONS;
        for (let index = 0; index < iterations; index += 1) {
          pendingRuns.push(await createRun());
        }
      },
      teardown: () => {
        if (measured) {
          measurements[name] = completedRuns.flatMap((run) =>
            run.metrics ? [run.metrics.snapshot()] : []);
        }
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
  const samples = Object.fromEntries(Object.entries(measurements).filter(([, runs]) => runs.length));
  if (Object.keys(samples).length) {
    console.log("Push measurements (means of measured iterations; milliseconds):");
    console.table(Object.fromEntries(Object.entries(samples).map(([name, runs]) => [name, {
      totalMs: mean(runs.map((run) => run.totalMs)),
      firstCommitMs: mean(runs.map((run) => run.firstCommitMs!)),
      noteAppliedP95Ms: mean(runs.map((run) => run.noteAppliedP95Ms!)),
      notesBeforeAttachment: mean(runs.map((run) => run.notesAppliedBeforeSlowUpload!)),
    }])));
    const output = process.env.SYNCH_SYNC_CLIENT_METRICS_PATH;
    if (output) {
      await writeFile(output, JSON.stringify({
        version: 1,
        environment: { node: process.version, platform: process.platform, arch: process.arch },
        fixture: MIXED_PUSH_FIXTURE_SPEC,
        profiles: MIXED_PROFILES,
        samples,
      }, null, 2) + "\n");
    }
  }
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

async function createMixedPushRun(profile: TransportProfile): Promise<BenchmarkRun> {
  const metrics = new PushMetrics();
  const server = new BenchmarkServer([], 0, profile, metrics);
  const fixture = await createMixedPushFixture();
  const store = createTestSyncStore(LOCAL_VAULT_ID);
  const harness = createEngineHarness(server, fixture.adapter, store, metrics);
  try {
    await harness.engine.reconcileOnce();
    const entriesByPath = new Map((await store.listEntries()).map((entry) => [entry.path, entry]));
    const pending = await store.listDirtyEntries();
    if (pending.length !== fixture.entries.length) throw new Error("Mixed fixture was not queued");
    const pendingById = new Map(pending.map((mutation) => [mutation.entryId, mutation]));
    const expected = new Map<string, { size: number; hash: string }>();
    // Apply the fixture's queue order independently of generated IDs and
    // filesystem enumeration. Expected hashes come from the original bytes.
    for (const [index, content] of fixture.entries.entries()) {
      const entry = entriesByPath.get(content.path);
      const mutation = entry ? pendingById.get(entry.entryId) : undefined;
      if (!mutation) throw new Error(`Mixed fixture file was not queued: ${content.path}`);
      await store.updateDirtyEntry({ ...mutation, createdAt: index + 1 });
      expected.set(mutation.entryId, { size: content.size, hash: content.hash });
    }
    await harness.engine.startAutoSync();
    harness.releaseDeferredWork();
    const run = createRunWithCleanup(harness, fixture.dispose, () => server.dispose(), async () => {
      await assertStoreIsClean(store, server.serverCursor);
      await server.assertUploadedContents(expected);
      if (metrics.snapshot().filesApplied !== expected.size) throw new Error("Missing completion observations");
    });
    return {
      ...run,
      metrics,
      run: async () => {
        metrics.start();
        try {
          await run.run();
        } finally {
          metrics.stop();
        }
      },
    };
  } catch (error) {
    await harness.dispose();
    await fixture.dispose();
    await server.dispose();
    throw error;
  }
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
  metrics?: PushMetrics,
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
    diagnostics: metrics ? {
      ...createNoopDiagnostics(),
      record: (event) => {
        if (event.type === "file_sync_completed" && event.direction === "upload") {
          metrics.fileCompleted(event.path);
        }
      },
    } : createNoopDiagnostics(),
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

async function delay(ms: number): Promise<void> {
  if (ms > 0) await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function mean(values: number[]): number {
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}
