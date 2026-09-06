import { SyncEngine, type SyncEngineDeps } from "@synch/sync-client/engine";
import { DEFAULT_SYNC_FILE_RULES, DEFAULT_VAULT_CONFIG_SYNC_RULES } from "@synch/sync-client/core";
import { createTestSyncStore } from "@synch/sync-client/testing";
import type { TestVault } from "@synch/sync-testkit/account";
import { createTransport } from "@synch/sync-testkit/transport";
import { FilesystemVault } from "./vault";
import { SyncMetrics } from "./metrics";
import { directScenario, type Scenario } from "./profiles";

export class Device {
  readonly store = createTestSyncStore();
  readonly vault: FilesystemVault;
  readonly metrics = new SyncMetrics();
  readonly engine: SyncEngine;
  readonly errors: string[] = [];
  private deferred = true;
  private measuring = false;
  private localId = "";
  private profile: Scenario = directScenario;
  cursor = 0;
  policy: { storageLimitBytes: number; maxFileSizeBytes: number } | undefined;
  downloadRequests = 0;
  downloadedBytes = 0;
  pageRequests = 0;
  private readonly transport = createTransport({
    beforeSend: text => {
      const message = JSON.parse(text);
      if (!this.measuring) return;
      if (message.type === "commit_mutations") {
        this.metrics.commitStarted();
        return delay(this.profile.commitDelayMs);
      }
      if (message.type === "list_entry_states") {
        this.pageRequests++;
        return delay(this.profile.pageDelayMs);
      }
    },
    received: text => {
      const message = JSON.parse(text);
      if (message.type === "hello_ack") this.policy = message.policy;
      if (typeof message.cursor === "number") this.cursor = Math.max(this.cursor, message.cursor);
      if (typeof message.targetCursor === "number") this.cursor = Math.max(this.cursor, message.targetCursor);
      if (this.measuring && message.type === "commit_mutations_committed" && message.results?.some((r: { status: string }) => r.status === "accepted")) this.metrics.commitAcknowledged();
    },
    beforeRequest: input => {
      if (!this.measuring || !input.url.includes("/blobs/")) return;
      if (input.method === "PUT" && input.body instanceof ArrayBuffer) {
        this.metrics.uploadStarted(input.body.byteLength);
        const attachment = this.profile.fixture === "mixed" && input.body.byteLength >= 8 * 1024 ** 2;
        return delay(this.profile.uploadDelayMs + (attachment ? this.profile.attachmentDelayMs : 0));
      }
      this.downloadRequests++;
      return delay(this.profile.downloadDelayMs);
    },
    response: (input, status, bytes) => {
      if (!this.measuring || !input.url.includes("/blobs/")) return;
      if (input.method !== "PUT") this.downloadedBytes += bytes.byteLength;
      if (status >= 200 && status < 300 && input.method === "PUT" && this.profile.fixture === "mixed" && input.body instanceof ArrayBuffer && input.body.byteLength >= 8 * 1024 ** 2) this.metrics.attachmentUploadCompleted();
    },
  });

  constructor(directory: string, baseUrl: string, remote: TestVault, key: Uint8Array) {
    this.vault = new FilesystemVault(directory);
    const error = (message: unknown) => { if (this.errors.length < 20) this.errors.push(String(message)); };
    this.engine = new SyncEngine({
      vaultAdapter: this.vault, vaultConfigSource: { listFiles: async () => [] }, changeSource: { start() {} },
      httpClient: this.transport.httpClient, createWebSocket: this.transport.createWebSocket,
      getApiBaseUrl: () => baseUrl, getSyncToken: () => remote.token(this.localId), invalidateSyncToken() {},
      getRemoteVaultKey: () => key, getConfigDir: () => ".obsidian",
      getSyncFileRules: () => ({ ...DEFAULT_SYNC_FILE_RULES, includeOtherFiles: true }),
      getVaultConfigSyncRules: () => DEFAULT_VAULT_CONFIG_SYNC_RULES,
      shouldDeferSyncWork: () => this.deferred, hasActiveRemoteVaultSession: () => true, isOffline: () => false,
      diagnostics: {
        record: event => { if (this.measuring && event.type === "file_sync_completed") this.metrics.fileCompleted(event.path); },
        recordError: error, clear() {}, getSnapshot: () => ({ count: 0, text: "" }), subscribe: () => () => {},
      },
      onSyncError: async e => { error(e); }, notifySyncConflict: () => error("Unexpected conflict"),
      notifyRollbackDetected: () => error("Unexpected rollback"),
      setSyncProgress() {}, setSyncStatus() {}, setStorageStatus() {},
    } satisfies SyncEngineDeps);
    this.engine.setStore(this.store);
  }
  async initialize(remote: TestVault) {
    this.localId = await this.store.readLocalVaultId();
    await this.store.writeSyncConnection({ localVaultId: this.localId, remoteVaultId: remote.id, lastPulledCursor: 0 });
  }
  async connect() {
    if (!(await this.engine.startAutoSync()) || !this.policy) throw new Error(`Session setup failed: ${this.errors.join("; ")}`);
  }
  async queue(paths: string[]) {
    await this.engine.reconcileOnce();
    const entries = new Map((await this.store.listEntries()).map(e => [e.path, e]));
    const dirty = await this.store.listDirtyEntries();
    if (dirty.length !== paths.length) throw new Error(`Pending count ${dirty.length} != ${paths.length}`);
    const mutations = new Map(dirty.map(m => [m.entryId, m]));
    for (const [i, path] of paths.entries()) {
      const id = entries.get(path)?.entryId;
      const mutation = id ? mutations.get(id) : undefined;
      if (!mutation) throw new Error(`Missing mutation: ${path}`);
      await this.store.updateDirtyEntry({ ...mutation, createdAt: i + 1 });
    }
  }
  async sync() {
    this.deferred = false;
    try {
      if (!(await this.engine.syncNow())) throw new Error("syncNow did not complete successfully");
      await this.engine.flushDebouncedPushAndWaitForInFlight();
      if (this.errors.length) throw new Error(this.errors.join("; "));
      if (this.engine.hasInFlightSyncWork() || await this.engine.hasPendingMutations()) throw new Error("Sync did not drain");
      if (await this.store.getCursor() !== this.cursor) throw new Error("Cursor did not converge");
    } finally { this.deferred = true; }
  }
  async measure(profile: Scenario) {
    this.profile = profile;
    this.measuring = true;
    this.metrics.start();
    try { await this.sync(); }
    finally { this.metrics.stop(); this.measuring = false; }
    return { ...this.metrics.snapshot(), pageRequests: this.pageRequests, downloadRequests: this.downloadRequests, downloadedBytes: this.downloadedBytes };
  }
  async close() {
    try { await this.engine.dispose(); } finally { this.transport.close(); await this.store.close(); }
  }
}
function delay(ms: number): Promise<void> | undefined {
  if (ms > 0) return new Promise(resolve => setTimeout(resolve, ms));
}
