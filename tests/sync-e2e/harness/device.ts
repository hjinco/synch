import { SyncEngine, type SyncChangeSourceContext, type SyncEngineDeps } from "@synch/sync-client/engine";
import { DEFAULT_SYNC_FILE_RULES, DEFAULT_VAULT_CONFIG_SYNC_RULES } from "@synch/sync-client/core";
import { InMemorySyncDiagnostics } from "@synch/sync-client/diagnostics";
import { createTestSyncStore, InMemoryVaultAdapter } from "@synch/sync-client/testing";
import type { TestVault } from "./account";
import { DeviceNetwork } from "./network";

export class Device {
  readonly vault = new InMemoryVaultAdapter();
  readonly store = createTestSyncStore();
  readonly network = new DeviceNetwork();
  readonly diagnostics = new InMemorySyncDiagnostics("sync-e2e");
  readonly errors: unknown[] = [];
  readonly conflicts: Parameters<SyncEngineDeps["notifySyncConflict"]>[0][] = [];
  readonly engine: SyncEngine;
  key: Uint8Array;
  private events!: SyncChangeSourceContext;
  private localVaultId = "";

  constructor(readonly name: string, baseUrl: string, remote: TestVault, key: Uint8Array) {
    this.key = key;
    this.engine = new SyncEngine({
      vaultAdapter: this.vault, vaultConfigSource: { listFiles: async () => [] },
      changeSource: { start: context => { this.events = context; } },
      httpClient: this.network.httpClient, createWebSocket: this.network.createWebSocket,
      getApiBaseUrl: () => baseUrl, getSyncToken: () => remote.token(this.localVaultId), invalidateSyncToken() {},
      getRemoteVaultKey: () => this.key, getConfigDir: () => ".obsidian",
      getSyncFileRules: () => DEFAULT_SYNC_FILE_RULES, getVaultConfigSyncRules: () => DEFAULT_VAULT_CONFIG_SYNC_RULES,
      shouldDeferSyncWork: () => false, hasActiveRemoteVaultSession: () => true, isOffline: () => false,
      diagnostics: this.diagnostics, onSyncError: error => { this.errors.push(error); },
      notifySyncConflict: event => { this.conflicts.push(event); },
      notifyRollbackDetected: event => { this.errors.push(event); },
      setSyncProgress() {}, setSyncStatus() {}, setStorageStatus() {},
    });
    this.engine.setStore(this.store);
    this.engine.registerVaultEvents();
  }

  async initialize(remote: TestVault) {
    this.localVaultId = await this.store.readLocalVaultId();
    await this.store.writeSyncConnection({ localVaultId: this.localVaultId, remoteVaultId: remote.id, lastPulledCursor: 0 });
  }
  async connect() { await this.engine.startAutoSync(); }
  async disconnect() {
    await this.engine.flushDebouncedPushAndWaitForInFlight();
    this.engine.stopAutoSync();
  }
  async sync() {
    await this.engine.syncNow();
    await this.engine.flushDebouncedPushAndWaitForInFlight();
    if (this.errors.length) throw new AggregateError(this.errors, `${this.name}: sync failed`);
  }
  async write(path: string, content: string | Uint8Array) {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    await this.vault.writeBinary(path, bytes);
    await this.events.runLocalMutationWork(() => this.events.eventRecorder.recordUpsert(path, bytes));
    this.events.notifyLocalChange();
  }
  async rename(from: string, to: string) {
    const bytes = await this.vault.readBytes(from);
    await this.vault.rename(from, to);
    await this.events.runLocalMutationWork(() => this.events.eventRecorder.recordRename(from, to, bytes));
    this.events.notifyLocalChange();
  }
  async remove(path: string) {
    await this.vault.remove(path);
    await this.events.runLocalMutationWork(() => this.events.eventRecorder.recordDelete(path));
    this.events.notifyLocalChange();
  }
  async snapshot() {
    const files = await this.vault.listFiles();
    return Object.fromEntries(await Promise.all(files.sort((a, b) => a.path.localeCompare(b.path)).map(async file => [file.path, Buffer.from(await file.readBytes()).toString("base64")])));
  }
  async debug() {
    return { device: this.name, files: await this.snapshot(), connection: await this.store.readSyncConnection(),
      pending: await this.store.listDirtyEntries(100), errors: this.errors.map(String), diagnostics: this.diagnostics.getSnapshot() };
  }
  async close() { await this.engine.dispose(); await this.store.close(); }
}
