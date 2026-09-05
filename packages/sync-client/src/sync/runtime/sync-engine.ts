import {
  isOffline as detectOffline,
  type OfflineDetector,
} from "../../http/network-status";
import type { HttpClient } from "../../http/request";
import type { RemoteVaultUnavailableError } from "../../remote-vault/unavailable";
import type {
  SyncDiagnostics,
  SyncFailurePhase,
} from "../diagnostics/types";
import { SyncAutoLoop } from "../engine/auto-sync";
import type { SyncTokenResponse } from "../remote/client";
import { SyncEventGate } from "../engine/event-gate";
import { SyncEventRecorder } from "../engine/event-recorder";
import {
  SyncContentRuntime,
  type SyncContentRuntimeDeps,
} from "../core/content-runtime";
import type { SyncFileRules } from "../core/file-rules";
import type { PresenceSelection } from "../core/presence";
import type { VaultConfigSyncRules } from "../core/vault-config-rules";
import {
  decideVaultPathSync,
  shouldApplyRemoteVaultPath,
  shouldUseLatestRemoteVaultConfig,
  type VaultPathPolicyRules,
} from "../core/vault-path-policy";
import {
  type ReconcileOnceResult,
  SyncLocalReconcileService,
} from "../engine/local-reconcile-service";
import type { SyncVaultAdapter, SyncVaultFile } from "../vault/ports";
import { SyncPullService } from "../engine/pull-service";
import { SyncPushService } from "../engine/push-service";
import { SyncAuthorizedRequestClient } from "../remote/request-client";
import { SyncBlobClient } from "../remote/blob-client";
import { SyncPullClient } from "../remote/pull-client";
import {
  type EntryVersion,
  type DeletedEntryPageCursor,
  type EntryVersionPageCursor,
  type SyncRealtimeSession,
  type SyncStorageStatus,
  type PresenceUpdatedPush,
  SyncRealtimeClient,
} from "../remote/realtime-client";
import type { WebSocketFactory } from "../remote/realtime-types";
import type { SyncStore } from "../store/store";
import {
  getOrCreateStoredLocalVaultId,
  readStoredSyncConnection,
} from "../store/connection";
import type { UserVisibleSyncState } from "./user-visible-status";
import type {
  SyncOperationProgress,
  UserVisibleSyncProgress,
  VaultSyncProgress,
} from "./user-visible-status";
import type { SyncChangeSource } from "./change-source";
import type { SyncVaultConfigSource } from "./vault-config-source";
import {
  SyncVersionHistoryService,
  type SyncDeletedEntriesPurgeResult,
  type SyncDeletedEntriesRestoreResult,
  type SyncDeletedEntriesPage,
  type SyncEntryVersionPreview,
  type SyncEntryVersionsPage,
} from "./version-history-service";
import {
  listFileSizeBlockedFiles,
  type SyncFileSizeBlockedFile,
} from "../engine/file-size-blocked";
import {
  SyncActivityTracker,
  type SyncActivityKind,
} from "../engine/sync-activity-tracker";
import { reapplyAllowedRemoteVaultConfig } from "../engine/vault-config-reapply";

const HIDDEN_FOLDER_RECONCILE_INTERVAL_MS = 60_000;

export interface SyncEngineDeps extends SyncContentRuntimeDeps {
  vaultAdapter: SyncVaultAdapter;
  vaultConfigSource: SyncVaultConfigSource;
  httpClient: HttpClient;
  changeSource: SyncChangeSource;
  getConfigDir: () => string;
  createWebSocket?: WebSocketFactory["create"];
  getApiBaseUrl: () => string;
  getSyncToken: () => Promise<SyncTokenResponse>;
  invalidateSyncToken: () => void;
  getRemoteVaultKey: () => Uint8Array;
  getSyncFileRules: () => SyncFileRules;
  getVaultConfigSyncRules: () => VaultConfigSyncRules;
  shouldDeferSyncWork: () => boolean;
  hasActiveRemoteVaultSession: () => boolean;
  diagnostics: SyncDiagnostics;
  onSyncError: (error: unknown, phase: SyncFailurePhase) => void | Promise<void>;
  notifySyncConflict: (event: {
    op: "upsert" | "delete";
    reason?: "local_pending_mutation" | "remote_path_collision";
    originalPath: string;
    conflictPath: string | null;
  }) => void;
  notifyRollbackDetected: (event: {
    entryId: string;
    path: string | null;
    localRevision: number;
    remoteRevision: number;
  }) => void;
  setSyncProgress: (progress: UserVisibleSyncProgress | null) => void;
  setSyncStatus: (status: UserVisibleSyncState) => void;
  setStorageStatus: (status: SyncStorageStatus | null) => void;
  onPresenceUpdated?: (update: PresenceUpdatedPush) => void;
  onPresenceCleared?: (presenceId: string) => void;
  onPresenceAvailabilityChanged?: (enabled: boolean) => void;
  onPresenceSessionReset?: () => void;
  onFileSizeBlockedFilesChange?: () => void;
  onLocalChangeQueued?: () => void;
  onStorageQuotaExceeded?: () => void | Promise<void>;
  onRemoteVaultUnavailable?: (
    error: RemoteVaultUnavailableError,
  ) => void | Promise<void>;
  isOffline?: OfflineDetector;
}

export class SyncEngine {
  private syncStore: SyncStore | null = null;
  private localMutationQueue: Promise<void> = Promise.resolve();
  private localMutationWorkCount = 0;
  private readonly activities = new SyncActivityTracker();
  private readonly activityProgress = new Map<number, SyncOperationProgress>();
  private hiddenFolderReconcileTimer: ReturnType<typeof setInterval> | null = null;
  private hiddenFolderReconcilePromise: Promise<void> | null = null;
  private readonly syncEventGate = new SyncEventGate();
  private readonly vaultAdapter: SyncVaultAdapter;
  private readonly vaultConfigSource: SyncVaultConfigSource;
  private readonly contentRuntime: SyncContentRuntime;
  private readonly ownsContentRuntime: boolean;
  private readonly syncEventRecorder: SyncEventRecorder;
  private readonly syncRequestClient: SyncAuthorizedRequestClient;
  private readonly syncPullClient: SyncPullClient;
  private readonly syncPushService: SyncPushService;
  private readonly syncLocalReconcileService: SyncLocalReconcileService;
  private readonly syncAutoLoop: SyncAutoLoop;
  private readonly syncPullService: SyncPullService;
  private readonly syncVersionHistoryService: SyncVersionHistoryService;
  private disposed = false;

  constructor(private readonly deps: SyncEngineDeps) {
    this.ownsContentRuntime = !deps.contentRuntime;
    this.contentRuntime = deps.contentRuntime ?? new SyncContentRuntime();
    this.vaultAdapter = deps.vaultAdapter;
    this.vaultConfigSource = deps.vaultConfigSource;
    this.syncEventRecorder = new SyncEventRecorder({
      getSyncStore: () => this.syncStore,
      getRemoteVaultKey: () => this.deps.getRemoteVaultKey(),
      eventGate: this.syncEventGate,
      contentRuntime: this.contentRuntime,
    });

    this.syncRequestClient = new SyncAuthorizedRequestClient({
      getApiBaseUrl: () => this.deps.getApiBaseUrl(),
      getSyncToken: async () => await this.deps.getSyncToken(),
      invalidateSyncToken: () => this.deps.invalidateSyncToken(),
      httpClient: this.deps.httpClient,
    });
    this.syncPullClient = new SyncPullClient(this.syncRequestClient);
    this.syncPushService = new SyncPushService({
      getApiBaseUrl: () => this.deps.getApiBaseUrl(),
      getSyncToken: async () => await this.deps.getSyncToken(),
      getSyncStore: () => this.syncStore,
      getRemoteVaultKey: () => this.deps.getRemoteVaultKey(),
      fileReader: this.vaultAdapter,
      conflictFileWriter: this.vaultAdapter,
      blobClient: new SyncBlobClient(this.syncRequestClient),
      contentRuntime: this.contentRuntime,
      onConflict: (event) => this.deps.notifySyncConflict(event),
      onFileSizeBlockedFilesChange: () => {
        this.deps.onFileSizeBlockedFilesChange?.();
      },
      onFileSyncStarted: (event) => {
        this.deps.diagnostics.record({
          type: "file_sync_started",
          direction: "upload",
          ...event,
        });
      },
      onFileSyncCompleted: (event) => {
        this.deps.diagnostics.record({
          type: "file_sync_completed",
          direction: "upload",
          ...event,
        });
      },
      onFileSyncFailed: (event) => {
        this.deps.diagnostics.record({
          type: "file_sync_failed",
          direction: "upload",
          ...event,
        });
      },
    });
    this.syncLocalReconcileService = new SyncLocalReconcileService({
      getSyncStore: () => this.syncStore,
      getRemoteVaultKey: () => this.deps.getRemoteVaultKey(),
      shouldSyncPath: (path) =>
        this.decideVaultPathSync(path).kind === "sync",
      scanner: {
        listFiles: async () => {
          const byPath = new Map<string, SyncVaultFile>();
          for (const file of await this.vaultAdapter.listFiles()) {
            byPath.set(file.path, file);
          }
          for (const file of await this.vaultConfigSource.listFiles()) {
            byPath.set(file.path, file);
          }
          return [...byPath.values()];
        },
      },
      contentRuntime: this.contentRuntime,
    });
    this.syncAutoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => this.deps.getApiBaseUrl(),
      getSyncToken: async () => await this.deps.getSyncToken(),
      getSyncStore: () => this.syncStore,
      realtimeClient: new SyncRealtimeClient({
        create: (url, protocols) =>
          this.deps.createWebSocket
            ? this.deps.createWebSocket(url, protocols)
            : new WebSocket(url, protocols),
      }),
      pushPendingMutations: async (session) =>
        await this.withSyncActivity("push", async (report) => {
          return await this.syncPushService.pushPendingMutations(session, report);
        }),
      unblockFileSizeBlockedMutations: async (session) =>
        await this.withSyncActivity("local", async () => {
          const unblocked = await this.syncPushService.unblockFileSizeBlockedMutations(
            session.maxFileSizeBytes,
          );
          if (unblocked > 0) {
            this.deps.onFileSizeBlockedFilesChange?.();
          }
          return unblocked;
        }),
      pullOnce: async (session) =>
        await this.withSyncActivity("pull", async (report) => {
          return await this.syncPullService.pullOnce(session, report);
        }),
      shouldDeferSyncWork: () => this.deps.shouldDeferSyncWork(),
      onConnectionStateChange: (state) => {
        this.deps.diagnostics.record({
          type: "connection_state_changed",
          state,
        });
        if (state === "reconnecting") {
          this.setOnlineSyncStatus("reconnecting");
          return;
        }

        if (state === "connecting") {
          this.setOnlineSyncStatus("syncing");
        }
      },
      onStorageStatusChange: (status) => {
        this.deps.setStorageStatus(status);
      },
      onPresenceUpdated: (update) => {
        this.deps.onPresenceUpdated?.(update);
      },
      onPresenceCleared: (presenceId) => {
        this.deps.onPresenceCleared?.(presenceId);
      },
      onPresenceAvailabilityChanged: (enabled) => {
        this.deps.onPresenceAvailabilityChanged?.(enabled);
      },
      onPresenceSessionReset: () => {
        this.deps.onPresenceSessionReset?.();
      },
      onSyncScheduled: () => {
        this.deps.diagnostics.record({
          type: "work_scheduled",
          mode: "immediate",
        });
        this.setOnlineSyncStatus("syncing");
      },
      onSyncDeferred: () => {
        this.deps.diagnostics.record({
          type: "work_scheduled",
          mode: "deferred",
        });
        this.deps.setSyncStatus("pending");
      },
      onIdle: () => {
        this.deps.setSyncStatus("up_to_date");
      },
      onError: (error) => {
        void this.deps.onSyncError(error, "auto_sync");
      },
      onRetryScheduled: ({ attempt, delayMs }) => {
        this.deps.diagnostics.record({
          type: "retry_scheduled",
          attempt,
          delayMs,
        });
      },
      onRemoteVaultUnavailable: async (error) => {
        await this.deps.onRemoteVaultUnavailable?.(error);
      },
      onStorageQuotaExceeded: async () => {
        this.deps.diagnostics.record({
          type: "storage_quota_exceeded",
        });
        await this.deps.onStorageQuotaExceeded?.();
      },
    });
    this.syncPullService = new SyncPullService({
      getApiBaseUrl: () => this.deps.getApiBaseUrl(),
      getSyncToken: async () => await this.deps.getSyncToken(),
      getSyncStore: () => this.syncStore,
      getRemoteVaultKey: () => this.deps.getRemoteVaultKey(),
      shouldApplyRemotePath: (path) =>
        shouldApplyRemoteVaultPath(path, this.vaultPathPolicyRules()),
      shouldUseLatestRemoteVersion: (path) =>
        shouldUseLatestRemoteVaultConfig(path, this.vaultPathPolicyRules()),
      eventGate: this.syncEventGate,
      vaultAdapter: this.vaultAdapter,
      pullClient: this.syncPullClient,
      contentRuntime: this.contentRuntime,
      onConflict: (event) => this.deps.notifySyncConflict(event),
      onRollbackDetected: (event) => this.deps.notifyRollbackDetected(event),
      onFileSyncStarted: (event) => {
        this.deps.diagnostics.record({
          type: "file_sync_started",
          direction: "download",
          ...event,
        });
      },
      onFileSyncCompleted: (event) => {
        this.deps.diagnostics.record({
          type: "file_sync_completed",
          direction: "download",
          ...event,
        });
      },
      onFileSyncFailed: (event) => {
        this.deps.diagnostics.record({
          type: "file_sync_failed",
          direction: "download",
          ...event,
        });
      },
    });
    this.syncVersionHistoryService = new SyncVersionHistoryService({
      getApiBaseUrl: () => this.deps.getApiBaseUrl(),
      getSyncToken: async () => await this.deps.getSyncToken(),
      getStore: () => this.requireStore(),
      getRemoteVaultKey: () => this.deps.getRemoteVaultKey(),
      pullClient: this.syncPullClient,
      contentRuntime: this.contentRuntime,
      withRealtimeSession: async (work) => await this.withRealtimeSession(work),
      runLocalMutationWork: async (work) => await this.runLocalMutationWork(work),
      pullOnce: async (session) => {
        await this.withSyncActivity("pull", async (report) => {
          await this.syncPullService.pullOnce(session, report);
        });
      },
    });
  }

  setStore(store: SyncStore): void {
    this.syncStore = store;
  }

  hasStore(): boolean {
    return this.syncStore !== null;
  }

  detachStore(): SyncStore | null {
    const store = this.syncStore;
    this.syncStore = null;
    return store;
  }

  async closeStore(): Promise<void> {
    const store = this.detachStore();
    await store?.close();
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.stopAutoSync();
    if (this.ownsContentRuntime) {
      await this.contentRuntime.dispose();
    }
  }

  async readLocalVaultId(): Promise<string> {
    return (await readStoredSyncConnection(this.requireStore()))?.localVaultId ?? "";
  }

  async getEntryIdForPath(path: string): Promise<string | null> {
    return (await this.syncStore?.getEntryByPath(path))?.entryId ?? null;
  }

  async getPathForEntryId(entryId: string): Promise<string | null> {
    return (await this.syncStore?.getEntryById(entryId))?.path ?? null;
  }

  shouldSyncPath(path: string): boolean {
    return this.decideVaultPathSync(path).kind === "sync";
  }

  async getOrCreateLocalVaultId(remoteVaultId: string): Promise<string> {
    return await getOrCreateStoredLocalVaultId(this.requireStore(), remoteVaultId);
  }

  async detachLocalVaultFromServer(): Promise<void> {
    await this.withRealtimeSession(async (session) => {
      await session.detachLocalVault();
    });
  }

  async startAutoSync(): Promise<boolean> {
    const started = await this.syncAutoLoop.start();
    this.startHiddenFolderReconcileTimer();
    return started;
  }

  stopAutoSync(): void {
    this.stopHiddenFolderReconcileTimer();
    this.syncAutoLoop.stop();
  }

  reconnectAutoSync(): void {
    this.syncAutoLoop.reconnectNow();
  }

  async resumeAutoSyncConnection(): Promise<void> {
    await this.syncAutoLoop.resumeConnection();
    this.startHiddenFolderReconcileTimer();
  }

  refreshHiddenFolderReconcileTimer(): void {
    if (this.hasPolledReconcileSources()) {
      this.startHiddenFolderReconcileTimer();
      return;
    }

    this.stopHiddenFolderReconcileTimer();
  }

  registerVaultEvents(): void {
    this.deps.changeSource.start({
      eventRecorder: this.syncEventRecorder,
      notifyLocalChange: () => this.notifyLocalChange(),
      runLocalMutationWork: async (work) => await this.runLocalMutationWork(work),
      hasActiveRemoteVaultSession: () => this.deps.hasActiveRemoteVaultSession(),
      onError: (error) => {
        void this.deps.onSyncError(error, "sync_event_handling");
      },
      onFileQueued: (event) => {
        this.deps.diagnostics.record({
          type: "local_file_queued",
          ...event,
        });
      },
      onFileError: ({ error: _error, ...event }) => {
        this.deps.diagnostics.record({
          type: "file_sync_failed",
          direction: "local",
          ...event,
          reason: "queue_failed",
        });
      },
    });
  }

  notifyLocalChange(): void {
    this.deps.onLocalChangeQueued?.();
    this.syncAutoLoop.notifyLocalChange();
  }

  async syncNow(): Promise<boolean> {
    return await this.syncAutoLoop.syncNow();
  }

  async flushDebouncedPushAndWaitForInFlight(): Promise<void> {
    await this.waitForLocalMutationWork();
    this.syncAutoLoop.flushDebouncedPush();
    await this.syncAutoLoop.waitForInFlightDrain();
  }

  hasInFlightSyncWork(): boolean {
    return this.localMutationWorkCount > 0 || this.syncAutoLoop.hasInFlightWork();
  }

  setStorageStatusWatching(enabled: boolean): void {
    this.syncAutoLoop.setStorageStatusWatching(enabled);
  }

  setPresenceWatching(enabled: boolean): void {
    this.syncAutoLoop.setPresenceWatching(enabled);
  }

  setPresenceWatchEntryIds(entryIds: string[]): void {
    this.syncAutoLoop.setPresenceWatchEntryIds(entryIds);
  }

  updatePresence(entryId: string, selection: PresenceSelection): void {
    this.syncAutoLoop.updatePresence(entryId, selection);
  }

  clearPresence(): void {
    this.syncAutoLoop.clearPresence();
  }

  async reconcileOnce(): Promise<ReconcileOnceResult> {
    return await this.runLocalMutationWork(async () => {
      return await this.syncLocalReconcileService.reconcileOnce();
    });
  }

  async reapplyAllowedRemoteVaultConfig(): Promise<number> {
    return await this.runLocalMutationWork(async () => {
      return await reapplyAllowedRemoteVaultConfig({
        store: this.requireStore(),
        rules: this.deps.getVaultConfigSyncRules(),
        configDir: this.configDir(),
        vaultWriter: this.vaultAdapter,
        eventGate: this.syncEventGate,
        pullClient: this.syncPullClient,
        getApiBaseUrl: () => this.deps.getApiBaseUrl(),
        getSyncToken: () => this.deps.getSyncToken(),
        getRemoteVaultKey: () => this.deps.getRemoteVaultKey(),
        contentRuntime: this.contentRuntime,
      });
    });
  }

  async refreshSyncProgress(): Promise<void> {
    const store = this.syncStore;
    if (!store) {
      this.reportBaselineProgress({
        completedEntries: 0,
        totalEntries: 0,
      });
      return;
    }

    this.reportBaselineProgress(await store.countSyncProgress());
  }

  async hasPendingMutations(): Promise<boolean> {
    const pending = await this.syncStore?.listDirtyEntries(1);
    return (pending?.length ?? 0) > 0;
  }

  private startHiddenFolderReconcileTimer(): void {
    if (
      this.hiddenFolderReconcileTimer !== null ||
      !this.hasPolledReconcileSources()
    ) {
      return;
    }

    this.hiddenFolderReconcileTimer = setInterval(() => {
      void this.reconcileHiddenFoldersFromTimer();
    }, HIDDEN_FOLDER_RECONCILE_INTERVAL_MS);
  }

  private stopHiddenFolderReconcileTimer(): void {
    if (this.hiddenFolderReconcileTimer === null) {
      return;
    }

    clearInterval(this.hiddenFolderReconcileTimer);
    this.hiddenFolderReconcileTimer = null;
  }

  private async reconcileHiddenFoldersFromTimer(): Promise<void> {
    if (
      this.hiddenFolderReconcilePromise ||
      !this.hasPolledReconcileSources() ||
      !this.deps.hasActiveRemoteVaultSession() ||
      !this.syncStore
    ) {
      return;
    }

    this.hiddenFolderReconcilePromise = this.reconcileHiddenFoldersOnce();
    try {
      await this.hiddenFolderReconcilePromise;
    } finally {
      this.hiddenFolderReconcilePromise = null;
    }
  }

  private async reconcileHiddenFoldersOnce(): Promise<void> {
    try {
      const result = await this.reconcileOnce();
      if (result.filesQueuedForUpsert > 0 || result.filesQueuedForDelete > 0) {
        this.notifyLocalChange();
      }
    } catch (error) {
      void this.deps.onSyncError(error, "hidden_folder_scan");
    }
  }

  private hasPolledReconcileSources(): boolean {
    return (
      this.deps.getSyncFileRules().includedHiddenFolders.length > 0 ||
      this.deps.getVaultConfigSyncRules().enabled
    );
  }

  private decideVaultPathSync(path: string) {
    return decideVaultPathSync(path, this.vaultPathPolicyRules());
  }

  private vaultPathPolicyRules(): VaultPathPolicyRules {
    return {
      fileRules: this.deps.getSyncFileRules(),
      vaultConfigRules: this.deps.getVaultConfigSyncRules(),
      configDir: this.configDir(),
    };
  }

  private configDir(): string {
    return this.deps.getConfigDir();
  }

  async listFileSizeBlockedFiles(): Promise<SyncFileSizeBlockedFile[]> {
    const store = this.syncStore;
    if (!store) {
      return [];
    }

    return await listFileSizeBlockedFiles(store, this.deps.getRemoteVaultKey());
  }

  async listEntryVersionsForPath(
    path: string,
    before: EntryVersionPageCursor | null,
    limit: number,
  ): Promise<SyncEngineEntryVersionsPage | null> {
    return await this.syncVersionHistoryService.listEntryVersionsForPath(
      path,
      before,
      limit,
    );
  }

  async previewEntryVersionForPath(
    path: string,
    version: EntryVersion,
  ): Promise<SyncEntryVersionPreview> {
    return await this.syncVersionHistoryService.previewEntryVersionForPath(path, version);
  }

  async restoreEntryVersionForPath(
    path: string,
    version: EntryVersion,
  ): Promise<void> {
    await this.syncVersionHistoryService.restoreEntryVersionForPath(path, version);
  }

  async listDeletedEntries(
    before: DeletedEntryPageCursor | null,
    limit: number,
  ): Promise<SyncDeletedEntriesPage> {
    return await this.syncVersionHistoryService.listDeletedEntries(before, limit);
  }

  async restoreDeletedEntries(
    entries: Array<{ entryId: string; revision: number }>,
  ): Promise<SyncDeletedEntriesRestoreResult> {
    return await this.syncVersionHistoryService.restoreDeletedEntries(entries);
  }

  async purgeDeletedEntries(
    entries: Array<{ entryId: string; revision: number }>,
  ): Promise<SyncDeletedEntriesPurgeResult> {
    return await this.syncVersionHistoryService.purgeDeletedEntries(entries);
  }

  async previewDeletedEntry(
    entryId: string,
    fallbackPath: string,
  ): Promise<SyncEntryVersionPreview> {
    return await this.syncVersionHistoryService.previewDeletedEntry(
      entryId,
      fallbackPath,
    );
  }

  async waitForLocalMutationWork(): Promise<void> {
    await this.localMutationQueue;
  }

  private async withRealtimeSession<T>(
    work: (session: SyncRealtimeSession) => Promise<T>,
  ): Promise<T> {
    return await this.syncAutoLoop.withRealtimeSession(work);
  }

  private runLocalMutationWork<T>(work: () => Promise<T>): Promise<T> {
    this.localMutationWorkCount += 1;
    const run = this.localMutationQueue.then(
      () => this.withSyncActivity("local", work),
      () => this.withSyncActivity("local", work),
    );
    this.localMutationQueue = run.then(
      () => {
        this.localMutationWorkCount -= 1;
      },
      () => {
        this.localMutationWorkCount -= 1;
      },
    );
    return run;
  }

  private async withSyncActivity<T>(
    kind: SyncActivityKind,
    work: (report: (progress: SyncOperationProgress) => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const activity = this.activities.begin(kind);
    try {
      return await work(async (progress) => {
        if (!this.activities.contains(activity)) {
          return;
        }
        this.activityProgress.set(activity.id, progress);
        if (this.activities.visibleRemoteActivity()?.id === activity.id) {
          this.deps.setSyncProgress(progress);
        }
      });
    } finally {
      const wasVisible = this.activities.visibleRemoteActivity()?.id === activity.id;
      this.activities.end(activity);
      this.activityProgress.delete(activity.id);
      const visible = this.activities.visibleRemoteActivity();
      const progress = visible && this.activityProgress.get(visible.id);
      if (wasVisible && progress) {
        this.deps.setSyncProgress(progress);
      }
      await this.refreshSyncProgress();
    }
  }

  private reportBaselineProgress(progress: VaultSyncProgress): void {
    if (!this.activities.hasActiveActivities()) {
      this.deps.setSyncProgress(progress);
    }
  }

  private requireStore(): SyncStore {
    if (!this.syncStore) {
      throw new Error("Local sync store is not initialized.");
    }

    return this.syncStore;
  }

  private isOffline(): boolean {
    return detectOffline(this.deps.isOffline);
  }

  private setOnlineSyncStatus(status: "reconnecting" | "syncing"): void {
    this.deps.setSyncStatus(this.isOffline() ? "offline" : status);
  }
}

export type { SyncFileSizeBlockedFile } from "../engine/file-size-blocked";
export type SyncEngineEntryVersionsPage = SyncEntryVersionsPage;
