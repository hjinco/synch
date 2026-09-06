import { Notice, type Plugin } from "obsidian";

import {
  isOffline as detectOffline,
  isOfflineLikeError,
  type OfflineDetector,
} from "@synch/sync-client/http/network-status";
import {
  isRemoteVaultUnavailableError,
  type RemoteVaultUnavailableError,
} from "@synch/sync-client/remote-vault/unavailable";
import type { SyncTokenResponse } from "@synch/sync-client/sync/remote/client";
import type {
  SyncDiagnosticErrorClassification,
  SyncDiagnosticSource,
  SyncDiagnostics,
  SyncFailurePhase,
} from "@synch/sync-client/sync/diagnostics/types";
import type {
  DeletedEntryPageCursor,
  EntryVersion,
  EntryVersionPageCursor,
  SyncStorageStatus,
} from "@synch/sync-client/sync/remote/realtime-client";
import type { SyncFileRules } from "@synch/sync-client/sync/core/file-rules";
import type { PresenceSelection } from "@synch/sync-client/sync/core/presence";
import type { VaultConfigSyncRules } from "@synch/sync-client/sync/core/vault-config-rules";
import {
  clearDexieSyncStore,
  createDexieSyncStore,
  readDexieSyncStoreConnection,
} from "../adapters/dexie-store";
import type { SyncConnection } from "@synch/sync-client/sync/store/store";
import type { ReconcileOnceResult } from "@synch/sync-client/sync/engine/local-reconcile-service";
import type { SyncDeletedEntriesPage } from "@synch/sync-client/sync/runtime/version-history-service";
import type { SyncDeletedEntriesRestoreResult } from "@synch/sync-client/sync/runtime/version-history-service";
import type { SyncDeletedEntriesPurgeResult } from "@synch/sync-client/sync/runtime/version-history-service";
import {
  type SyncEngineEntryVersionsPage,
  type SyncFileSizeBlockedFile,
} from "@synch/sync-client/sync/runtime/sync-engine";
import { createObsidianSyncEngine } from "../adapters/sync-engine";
import type { PresenceRelay } from "../ui/presence/presence-relay";
import type { SyncEntryVersionPreview } from "@synch/sync-client/sync/runtime/version-history-service";
import {
  getUserVisibleSyncDisplayPercent,
  type UserVisibleSyncProgress,
  type UserVisibleSyncState,
} from "@synch/sync-client/sync/runtime/user-visible-status";

export interface SyncControllerDeps {
  plugin: Plugin;
  getApiBaseUrl: () => string;
  getSyncToken: () => Promise<SyncTokenResponse>;
  invalidateSyncToken: () => void;
  getRemoteVaultKey: () => Uint8Array;
  getSyncFileRules: () => SyncFileRules;
  getVaultConfigSyncRules: () => VaultConfigSyncRules;
  getSyncIntervalMs: () => number;
  hasActiveRemoteVaultSession: () => boolean;
  hasConnectedRemoteVault: () => boolean;
  hasAuthenticatedSession: () => boolean;
  diagnostics: SyncDiagnostics;
  notifyError: (error: unknown, phase: SyncFailurePhase) => void;
  notify?: (message: string, timeout?: number) => void;
  formatSyncConflictNotice?: (event: {
    op: "upsert" | "delete";
    reason?: "local_pending_mutation" | "remote_path_collision";
    originalPath: string;
    conflictPath: string | null;
  }) => string;
  formatRollbackDetectedNotice?: (event: {
    entryId: string;
    path: string | null;
    localRevision: number;
    remoteRevision: number;
  }) => string;
  onSyncStatusChange?: () => void;
  onStorageStatusChange?: () => void;
  onFileSizeBlockedFilesChange?: () => void;
  onStorageQuotaExceeded?: () => void | Promise<void>;
  onRemoteVaultUnavailable?: (
    error: RemoteVaultUnavailableError,
  ) => void | Promise<void>;
  isOffline?: OfflineDetector;
}

export class SyncController {
  private syncStatus: UserVisibleSyncState = "not_ready";
  private reconcileCount = 0;
  private syncProgress: UserVisibleSyncProgress = {
    completedEntries: 0,
    totalEntries: 0,
  };
  private readonly syncEngine = createObsidianSyncEngine({
    plugin: this.deps.plugin,
    getApiBaseUrl: () => this.deps.getApiBaseUrl(),
    getSyncToken: async () => await this.deps.getSyncToken(),
    invalidateSyncToken: () => this.deps.invalidateSyncToken(),
    getRemoteVaultKey: () => this.deps.getRemoteVaultKey(),
    getSyncFileRules: () => this.deps.getSyncFileRules(),
    getVaultConfigSyncRules: () => this.deps.getVaultConfigSyncRules(),
    shouldDeferSyncWork: () => this.deps.getSyncIntervalMs() > 0,
    hasActiveRemoteVaultSession: () => this.deps.hasActiveRemoteVaultSession(),
    diagnostics: this.deps.diagnostics,
    onSyncError: (error, phase) => {
      void this.handleSyncError(error, phase);
    },
    notifySyncConflict: (event) => this.notifySyncConflict(event),
    notifyRollbackDetected: (event) => this.notifyRollbackDetected(event),
    setSyncProgress: (progress) => this.setSyncProgress(progress),
    setSyncStatus: (status) => this.setSyncStatus(status),
    onReconcileStatusChange: (reconciling) => this.setReconcileStatus(reconciling),
    setStorageStatus: (status) => this.setStorageStatus(status),
    onPresenceUpdated: (update) => {
      this.presenceRelay?.onUpdated(update);
    },
    onPresenceCleared: (presenceId) => {
      this.presenceRelay?.onCleared(presenceId);
    },
    onPresenceAvailabilityChanged: (enabled) => {
      this.presenceRelay?.onAvailabilityChanged(enabled);
    },
    onPresenceSessionReset: () => {
      this.presenceRelay?.onReset();
    },
    onFileSizeBlockedFilesChange: () => {
      this.deps.onFileSizeBlockedFilesChange?.();
    },
    onLocalChangeQueued: () => {
      if (
        this.deps.getSyncIntervalMs() > 0 &&
        !this.periodicSyncPromise &&
        this.syncStatus === "up_to_date"
      ) {
        this.setSyncStatus("pending");
      }
    },
    onStorageQuotaExceeded: async () => {
      await this.deps.onStorageQuotaExceeded?.();
    },
    onRemoteVaultUnavailable: async (error) => {
      await this.handleRemoteVaultUnavailable(error);
    },
    isOffline: this.deps.isOffline,
  });
  private storageStatus: SyncStorageStatus | null = null;
  private presenceRelay: PresenceRelay | null = null;
  private periodicSyncTimer: number | null = null;
  private periodicSyncPromise: Promise<void> | null = null;
  private periodicSyncEnabled = false;

  constructor(private readonly deps: SyncControllerDeps) {}

  async readStoredConnection(): Promise<SyncConnection | null> {
    return await readDexieSyncStoreConnection(this.deps.plugin);
  }

  async initializeStore(remoteVaultId: string): Promise<void> {
    try {
      await this.syncEngine.closeStore();
      this.syncEngine.setStore(await createDexieSyncStore(this.deps.plugin));
      await this.syncEngine.getOrCreateLocalVaultId(remoteVaultId);
      await this.syncEngine.refreshSyncProgress();
    } catch (error) {
      this.setSyncStatus("attention_needed");
      await this.handleSyncError(error, "store_initialization");
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopPeriodicSync();
    this.syncEngine.setStorageStatusWatching(false);
    this.syncEngine.setPresenceWatching(false);
    this.syncEngine.stopAutoSync();
    this.setStorageStatus(null);
    await this.periodicSyncPromise?.catch(() => {});
    await this.syncEngine.closeStore();
    await this.syncEngine.dispose();
  }

  hasInFlightSync(): boolean {
    return this.periodicSyncPromise !== null || this.syncEngine.hasInFlightSyncWork();
  }

  queueQuitInFlightSyncWait(
    tasks: { addPromise: (promise: Promise<unknown>) => void },
    timeoutMs: number,
  ): void {
    if (!this.hasInFlightSync()) {
      return;
    }

    tasks.addPromise(this.waitForInFlightSync(timeoutMs));
  }

  async waitForInFlightSync(timeoutMs: number): Promise<void> {
    let timeout: number | undefined;
    try {
      await Promise.race([
        Promise.all([
          this.syncEngine.flushDebouncedPushAndWaitForInFlight(),
          this.periodicSyncPromise ?? Promise.resolve(),
        ]).catch(() => undefined),
        new Promise<void>((resolve) => {
          timeout = window.setTimeout(() => resolve(), timeoutMs);
        }),
      ]);
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async readLocalVaultId(): Promise<string> {
    return await this.syncEngine.readLocalVaultId();
  }

  async getOrCreateLocalVaultId(remoteVaultId: string): Promise<string> {
    return await this.syncEngine.getOrCreateLocalVaultId(remoteVaultId);
  }

  async detachLocalVaultFromServer(): Promise<void> {
    if (!this.deps.hasActiveRemoteVaultSession() || !this.deps.hasAuthenticatedSession()) {
      return;
    }

    await this.syncEngine.detachLocalVaultFromServer();
  }

  stopAutoSyncAndMarkNotReady(): void {
    this.stopPeriodicSync();
    this.syncEngine.setStorageStatusWatching(false);
    this.syncEngine.setPresenceWatching(false);
    this.syncEngine.stopAutoSync();
    this.setStorageStatus(null);
    this.setSyncProgress({
      completedEntries: 0,
      totalEntries: 0,
    });
    this.setSyncStatus("not_ready");
  }

  stopAutoSyncAndMarkPaused(): void {
    this.stopPeriodicSync();
    this.syncEngine.setStorageStatusWatching(false);
    this.syncEngine.setPresenceWatching(false);
    this.syncEngine.stopAutoSync();
    this.setStorageStatus(null);
    this.setSyncStatus("paused");
  }

  async resetLocalSyncState(): Promise<void> {
    this.stopPeriodicSync();
    this.syncEngine.setStorageStatusWatching(false);
    this.syncEngine.setPresenceWatching(false);
    this.syncEngine.stopAutoSync();
    this.setStorageStatus(null);
    const store = this.syncEngine.detachStore();
    try {
      await store?.close();
    } catch {
      // Continue clearing persisted sync state even if flushing the old store fails.
    }
    await clearDexieSyncStore(this.deps.plugin);
    this.setSyncProgress({
      completedEntries: 0,
      totalEntries: 0,
    });
    this.setSyncStatus("not_ready");
  }

  getSyncState(): UserVisibleSyncState {
    return this.reconcileCount > 0 ? "reconciling" : this.syncStatus;
  }

  getSyncPercent(): number {
    return getUserVisibleSyncDisplayPercent(this.syncStatus, this.syncProgress);
  }

  getSyncProgress(): UserVisibleSyncProgress {
    return this.syncProgress;
  }

  getStorageStatus(): SyncStorageStatus | null {
    return this.storageStatus;
  }

  hasStore(): boolean {
    return this.syncEngine.hasStore();
  }

  watchStorageStatus(): void {
    this.syncEngine.setStorageStatusWatching(true);
  }

  unwatchStorageStatus(): void {
    this.syncEngine.setStorageStatusWatching(false);
  }

  setPresenceRelay(relay: PresenceRelay | null): void {
    this.presenceRelay = relay;
  }

  watchPresence(entryIds: string[]): void {
    this.syncEngine.setPresenceWatchEntryIds(entryIds);
    this.syncEngine.setPresenceWatching(true);
  }

  unwatchPresence(): void {
    this.syncEngine.setPresenceWatching(false);
  }

  async getEntryIdForPath(path: string): Promise<string | null> {
    return await this.syncEngine.getEntryIdForPath(path);
  }

  async getPathForEntryId(entryId: string): Promise<string | null> {
    return await this.syncEngine.getPathForEntryId(entryId);
  }

  shouldSyncPath(path: string): boolean {
    return this.syncEngine.shouldSyncPath(path);
  }

  updatePresence(entryId: string, selection: PresenceSelection): void {
    this.syncEngine.updatePresence(entryId, selection);
  }

  clearPresence(): void {
    this.syncEngine.clearPresence();
  }

  async ensureAutoSyncState(): Promise<void> {
    if (!this.deps.hasActiveRemoteVaultSession() || !this.deps.hasAuthenticatedSession()) {
      this.stopPeriodicSync();
      this.syncEngine.setStorageStatusWatching(false);
      this.syncEngine.setPresenceWatching(false);
      this.syncEngine.stopAutoSync();
      this.setStorageStatus(null);
      if (this.shouldShowOfflineBeforeReady()) {
        this.setSyncStatus("offline");
        return;
      }

      this.setSyncProgress({
        completedEntries: 0,
        totalEntries: 0,
      });
      this.setSyncStatus("not_ready");
      return;
    }

    if (this.deps.getSyncIntervalMs() > 0) {
      try {
        this.syncEngine.setStorageStatusWatching(true);
        this.periodicSyncEnabled = true;
        await this.syncEngine.startAutoSync();
        await this.runPeriodicSyncAndSchedule();
      } catch (error) {
        await this.handleSyncError(error, "auto_sync_initialization");
      }
      return;
    }

    const wasPeriodic = this.periodicSyncEnabled;
    await this.stopPeriodicSyncAndWait();
    this.recordSyncStarted("startup");
    try {
      this.syncEngine.setStorageStatusWatching(true);
      const reconcile = await this.syncEngine.reconcileOnce();
      this.recordSyncReconciled("startup", reconcile);
      await this.syncEngine.waitForLocalMutationWork();
      await this.syncEngine.startAutoSync();
      if (wasPeriodic) {
        if (await this.syncEngine.syncNow()) {
          this.recordSyncCompleted("startup");
        }
        return;
      }
      const hasPendingMutations = await this.syncEngine.hasPendingMutations();
      if (
        hasPendingMutations ||
        reconcile.filesQueuedForUpsert > 0 ||
        reconcile.filesQueuedForDelete > 0
      ) {
        if (await this.syncEngine.syncNow()) {
          this.recordSyncCompleted("startup");
        }
        return;
      }
      this.recordSyncCompleted("startup");
    } catch (error) {
      this.syncEngine.setStorageStatusWatching(false);
      this.syncEngine.setPresenceWatching(false);
      this.setStorageStatus(null);
      await this.handleSyncError(error, "auto_sync_initialization");
    }
  }

  async resumeAutoSync(): Promise<void> {
    try {
      if (!this.deps.hasActiveRemoteVaultSession() || !this.deps.hasAuthenticatedSession()) {
        if (this.shouldShowOfflineBeforeReady()) {
          this.setSyncStatus("offline");
        }
        return;
      }

      if (!this.syncEngine.hasStore()) {
        await this.ensureAutoSyncState();
        return;
      }

      if (this.deps.getSyncIntervalMs() > 0) {
        this.syncEngine.setStorageStatusWatching(true);
        this.periodicSyncEnabled = true;
        if (this.periodicSyncTimer || this.periodicSyncPromise) {
          return;
        }
        const started = await this.syncEngine.startAutoSync();
        if (!started) {
          await this.syncEngine.resumeAutoSyncConnection();
        }
        await this.runPeriodicSyncAndSchedule();
        return;
      }

      const wasPeriodic = this.periodicSyncEnabled;
      await this.stopPeriodicSyncAndWait();
      this.syncEngine.setStorageStatusWatching(true);
      const started = await this.syncEngine.startAutoSync();
      if (!started) {
        await this.syncEngine.resumeAutoSyncConnection();
      }
      if (wasPeriodic) {
        await this.syncEngine.syncNow();
      }
    } catch (error) {
      await this.handleSyncError(error, "auto_sync_resume");
    }
  }

  registerVaultEvents(): void {
    this.syncEngine.registerVaultEvents();
  }

  async syncNow(): Promise<void> {
    if (!this.deps.hasActiveRemoteVaultSession() || !this.deps.hasAuthenticatedSession()) {
      return;
    }

    if (this.deps.getSyncIntervalMs() > 0) {
      this.periodicSyncEnabled = true;
      await this.runPeriodicSyncAndSchedule();
      return;
    }

    try {
      this.recordSyncStarted("manual");
      this.setSyncStatus("syncing");
      const reconcile = await this.syncEngine.reconcileOnce();
      this.recordSyncReconciled("manual", reconcile);
      await this.syncEngine.waitForLocalMutationWork();
      if (await this.syncEngine.syncNow()) {
        this.recordSyncCompleted("manual");
      }
    } catch (error) {
      await this.handleSyncError(error, "auto_sync");
    }
  }

  async reconcileAfterFileRuleChange(): Promise<void> {
    if (!this.deps.hasActiveRemoteVaultSession() || !this.syncEngine.hasStore()) {
      return;
    }

    try {
      this.setSyncStatus("syncing");
      await this.syncEngine.reapplyAllowedRemoteVaultConfig();
      if (this.deps.getSyncIntervalMs() > 0) {
        this.periodicSyncEnabled = true;
        await this.runPeriodicSyncAndSchedule();
        return;
      }
      this.recordSyncStarted("local_change");
      const reconcile = await this.syncEngine.reconcileOnce();
      this.recordSyncReconciled("local_change", reconcile);
      this.syncEngine.refreshHiddenFolderReconcileTimer();
      if (await this.syncEngine.syncNow()) {
        this.recordSyncCompleted("local_change");
      }
    } catch (error) {
      await this.handleSyncError(error, "file_rule_update");
    }
  }

  markOffline(): void {
    this.setSyncStatus("offline");
  }

  markAttentionNeeded(): void {
    this.setSyncStatus("attention_needed");
  }

  async listFileSizeBlockedFiles(): Promise<SyncFileSizeBlockedFile[]> {
    if (!this.deps.hasActiveRemoteVaultSession() || !this.deps.hasAuthenticatedSession()) {
      return [];
    }

    return await this.syncEngine.listFileSizeBlockedFiles();
  }

  async listEntryVersionsForPath(
    path: string,
    before: EntryVersionPageCursor | null,
    limit: number,
  ): Promise<SyncEngineEntryVersionsPage | null> {
    if (!this.deps.hasActiveRemoteVaultSession() || !this.deps.hasAuthenticatedSession()) {
      throw new Error("Connect and sign in before viewing version history.");
    }
    return await this.syncEngine.listEntryVersionsForPath(path, before, limit);
  }

  async previewEntryVersionForPath(
    path: string,
    version: EntryVersion,
  ): Promise<SyncEntryVersionPreview> {
    if (!this.deps.hasActiveRemoteVaultSession() || !this.deps.hasAuthenticatedSession()) {
      throw new Error("Connect and sign in before previewing version history.");
    }
    return await this.syncEngine.previewEntryVersionForPath(path, version);
  }

  async restoreEntryVersionForPath(path: string, version: EntryVersion): Promise<void> {
    if (!this.deps.hasActiveRemoteVaultSession() || !this.deps.hasAuthenticatedSession()) {
      throw new Error("Connect and sign in before restoring version history.");
    }
    await this.syncEngine.restoreEntryVersionForPath(path, version);
  }

  async listDeletedEntries(
    before: DeletedEntryPageCursor | null,
    limit: number,
  ): Promise<SyncDeletedEntriesPage> {
    if (!this.deps.hasActiveRemoteVaultSession() || !this.deps.hasAuthenticatedSession()) {
      throw new Error("Connect and sign in before viewing deleted files.");
    }
    return await this.syncEngine.listDeletedEntries(before, limit);
  }

  async restoreDeletedEntries(
    entries: Array<{ entryId: string; revision: number }>,
  ): Promise<SyncDeletedEntriesRestoreResult> {
    if (!this.deps.hasActiveRemoteVaultSession() || !this.deps.hasAuthenticatedSession()) {
      throw new Error("Connect and sign in before restoring deleted files.");
    }
    return await this.syncEngine.restoreDeletedEntries(entries);
  }

  async purgeDeletedEntries(
    entries: Array<{ entryId: string; revision: number }>,
  ): Promise<SyncDeletedEntriesPurgeResult> {
    if (!this.deps.hasActiveRemoteVaultSession() || !this.deps.hasAuthenticatedSession()) {
      throw new Error("Connect and sign in before purging deleted files.");
    }
    return await this.syncEngine.purgeDeletedEntries(entries);
  }

  async previewDeletedEntry(
    entryId: string,
    fallbackPath: string,
  ): Promise<SyncEntryVersionPreview> {
    if (!this.deps.hasActiveRemoteVaultSession() || !this.deps.hasAuthenticatedSession()) {
      throw new Error("Connect and sign in before previewing deleted files.");
    }
    return await this.syncEngine.previewDeletedEntry(entryId, fallbackPath);
  }

  private setSyncStatus(status: UserVisibleSyncState): void {
    if (this.syncStatus === status) {
      return;
    }

    this.syncStatus = status;
    this.deps.onSyncStatusChange?.();
  }

  private setReconcileStatus(reconciling: boolean): void {
    const previousIsReconciling = this.reconcileCount > 0;
    this.reconcileCount = Math.max(
      0,
      this.reconcileCount + (reconciling ? 1 : -1),
    );
    if (previousIsReconciling === (this.reconcileCount > 0)) {
      return;
    }

    this.deps.onSyncStatusChange?.();
  }

  private recordSyncStarted(source: SyncDiagnosticSource): void {
    this.deps.diagnostics.record({
      type: "sync_started",
      source,
    });
  }

  private recordSyncReconciled(
    source: SyncDiagnosticSource,
    result: ReconcileOnceResult,
  ): void {
    this.deps.diagnostics.record({
      type: "sync_reconciled",
      source,
      filesScanned: result.filesScanned,
      filesQueuedForUpsert: result.filesQueuedForUpsert,
      filesQueuedForDelete: result.filesQueuedForDelete,
    });
  }

  private recordSyncCompleted(source: SyncDiagnosticSource): void {
    this.deps.diagnostics.record({
      type: "sync_completed",
      source,
    });
  }

  private async runPeriodicSyncAndSchedule(): Promise<void> {
    this.clearPeriodicSyncTimer();
    if (this.periodicSyncPromise) {
      await this.periodicSyncPromise;
      return;
    }

    this.periodicSyncPromise = this.runPeriodicSyncCycle();
    try {
      await this.periodicSyncPromise;
    } finally {
      this.periodicSyncPromise = null;
      this.scheduleNextPeriodicSync();
    }
  }

  private async runPeriodicSyncCycle(): Promise<void> {
    try {
      this.recordSyncStarted("periodic");
      this.setSyncStatus("syncing");
      const reconcile = await this.syncEngine.reconcileOnce();
      this.recordSyncReconciled("periodic", reconcile);
      await this.syncEngine.waitForLocalMutationWork();
      if (await this.syncEngine.syncNow()) {
        this.recordSyncCompleted("periodic");
      }
    } catch (error) {
      if (!this.periodicSyncEnabled) {
        return;
      }
      await this.handleSyncError(error, "auto_sync");
    }
  }

  private scheduleNextPeriodicSync(): void {
    const intervalMs = this.deps.getSyncIntervalMs();
    if (!this.periodicSyncEnabled || intervalMs <= 0 || this.periodicSyncTimer) {
      return;
    }

    this.periodicSyncTimer = window.setTimeout(() => {
      this.periodicSyncTimer = null;
      void this.runPeriodicSyncAndSchedule();
    }, intervalMs);
  }

  private stopPeriodicSync(): void {
    this.periodicSyncEnabled = false;
    this.clearPeriodicSyncTimer();
  }

  private async stopPeriodicSyncAndWait(): Promise<void> {
    this.stopPeriodicSync();
    if (!this.periodicSyncPromise) {
      return;
    }
    await this.periodicSyncPromise;
  }

  private clearPeriodicSyncTimer(): void {
    if (!this.periodicSyncTimer) {
      return;
    }
    window.clearTimeout(this.periodicSyncTimer);
    this.periodicSyncTimer = null;
  }

  recordSyncError(
    error: unknown,
    phase: SyncFailurePhase,
    classification: SyncDiagnosticErrorClassification = "unexpected",
  ): void {
    this.deps.diagnostics.recordError({
      phase,
      classification,
      error,
    });
  }

  private async handleSyncError(
    error: unknown,
    phase: SyncFailurePhase,
  ): Promise<void> {
    if (isRemoteVaultUnavailableError(error)) {
      this.recordSyncError(error, phase, "remote_vault_unavailable");
      await this.handleRemoteVaultUnavailable(error);
      return;
    }
    if (isOfflineLikeError(error, this.deps.isOffline)) {
      this.recordSyncError(error, phase, "offline");
      this.setSyncStatus("offline");
      return;
    }
    this.recordSyncError(error, phase);
    this.setSyncStatus("attention_needed");
    this.deps.notifyError(error, phase);
  }

  private setSyncProgress(progress: UserVisibleSyncProgress | null): void {
    if (!progress) {
      return;
    }

    const normalized = {
      ...progress,
      completedEntries: Math.max(0, progress.completedEntries),
      totalEntries: Math.max(0, progress.totalEntries),
    };

    if (
      this.syncProgress?.completedEntries === normalized?.completedEntries &&
      this.syncProgress?.totalEntries === normalized?.totalEntries &&
      this.syncProgress?.totalKnown === normalized.totalKnown &&
      this.syncProgress?.direction === normalized.direction
    ) {
      return;
    }

    this.syncProgress = normalized;
    this.deps.onSyncStatusChange?.();
  }

  private setStorageStatus(status: SyncStorageStatus | null): void {
    if (
      this.storageStatus?.storageUsedBytes === status?.storageUsedBytes &&
      this.storageStatus?.storageLimitBytes === status?.storageLimitBytes
    ) {
      return;
    }

    this.storageStatus = status;
    this.deps.onStorageStatusChange?.();
  }

  private notify(message: string, timeout?: number): void {
    if (this.deps.notify) {
      this.deps.notify(message, timeout);
      return;
    }

    new Notice(message, timeout);
  }

  private async handleRemoteVaultUnavailable(
    error: RemoteVaultUnavailableError,
  ): Promise<void> {
    this.deps.diagnostics.record({
      type: "remote_vault_unavailable",
      reason: error.reason === "not_found" ? "not_found" : "access_denied",
    });
    this.stopAutoSyncAndMarkNotReady();
    await this.deps.onRemoteVaultUnavailable?.(error);
  }

  private notifySyncConflict(event: {
    op: "upsert" | "delete";
    reason?: "local_pending_mutation" | "remote_path_collision";
    originalPath: string;
    conflictPath: string | null;
  }): void {
    const message = this.deps.formatSyncConflictNotice?.(event);
    if (message) {
      this.notify(message);
    }
  }

  private notifyRollbackDetected(event: {
    entryId: string;
    path: string | null;
    localRevision: number;
    remoteRevision: number;
  }): void {
    this.deps.diagnostics.record({
      type: "rollback_rejected",
      localRevision: event.localRevision,
      remoteRevision: event.remoteRevision,
    });
    const message = this.deps.formatRollbackDetectedNotice?.(event);
    if (message) {
      this.notify(message);
    }
  }

  private shouldShowOfflineBeforeReady(): boolean {
    return (
      this.deps.hasAuthenticatedSession() &&
      this.deps.hasConnectedRemoteVault() &&
      (this.syncStatus === "offline" || detectOffline(this.deps.isOffline))
    );
  }
}
