import type { Plugin } from "obsidian";

import {
  isOffline as detectOffline,
  isOfflineLikeError,
  type OfflineDetector,
} from "../../http/network-status";
import type { RemoteVaultUnavailableError } from "../../remote-vault/unavailable";
import { SyncAutoLoop } from "../engine/auto-sync";
import type { SyncTokenResponse } from "../remote/client";
import { SyncEventGate } from "../engine/event-gate";
import { SyncEventRecorder } from "../engine/event-recorder";
import type { SyncFileRules } from "../core/file-rules";
import { decryptSyncMetadata } from "../core/crypto";
import {
  type ReconcileOnceResult,
  SyncLocalReconcileService,
} from "../engine/local-reconcile-service";
import { metadataContextFromMutation } from "../engine/push-mutation-shared";
import { ObsidianSyncVaultAdapter } from "../vault/obsidian-vault-adapter";
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
} from "../remote/realtime-client";
import type { SyncStore } from "../store/store";
import {
  getOrCreateStoredLocalVaultId,
  readStoredSyncConnection,
} from "../store/connection";
import type { UserVisibleSyncState } from "./user-visible-status";
import type { UserVisibleSyncProgress } from "./user-visible-status";
import { SyncVaultEventHandler } from "./vault-event-handler";
import {
  SyncVersionHistoryService,
  type SyncDeletedEntriesPurgeResult,
  type SyncDeletedEntriesRestoreResult,
  type SyncDeletedEntriesPage,
  type SyncEntryVersionPreview,
  type SyncEntryVersionsPage,
} from "./version-history-service";

type SyncActivityKind = "push" | "pull" | "local";

const HIDDEN_FOLDER_RECONCILE_INTERVAL_MS = 60_000;

interface ActiveSyncActivity {
  id: number;
  kind: SyncActivityKind;
}

export interface SyncEngineDeps {
  plugin: Plugin;
  getApiBaseUrl: () => string;
  getSyncToken: () => Promise<SyncTokenResponse>;
  invalidateSyncToken: () => void;
  getRemoteVaultKey: () => Uint8Array;
  getSyncFileRules: () => SyncFileRules;
  hasActiveRemoteVaultSession: () => boolean;
  notify: (message: string, timeout?: number) => void;
  notifyError: (error: unknown, prefix: string) => void;
  notifySyncConflict: (event: {
    op: "upsert" | "delete";
    reason?: "local_pending_mutation" | "remote_path_collision";
    originalPath: string;
    conflictPath: string | null;
  }) => void;
  setSyncProgress: (progress: UserVisibleSyncProgress | null) => void;
  setSyncStatus: (status: UserVisibleSyncState) => void;
  setStorageStatus: (status: SyncStorageStatus | null) => void;
  onFileSizeBlockedFilesChange?: () => void;
  onStorageQuotaExceeded?: () => void | Promise<void>;
  onRemoteVaultUnavailable?: (
    error: RemoteVaultUnavailableError,
  ) => void | Promise<void>;
  isOffline?: OfflineDetector;
}

export class SyncEngine {
  private syncStore: SyncStore | null = null;
  private localMutationQueue: Promise<void> = Promise.resolve();
  private activeSyncActivities: ActiveSyncActivity[] = [];
  private nextSyncActivityId = 1;
  private hiddenFolderReconcileTimer: ReturnType<typeof setInterval> | null = null;
  private hiddenFolderReconcilePromise: Promise<void> | null = null;
  private readonly syncEventGate = new SyncEventGate();
  private readonly vaultAdapter = new ObsidianSyncVaultAdapter(
    this.deps.plugin,
    () => this.deps.getSyncFileRules(),
  );
  private readonly syncEventRecorder = new SyncEventRecorder({
    getSyncStore: () => this.syncStore,
    getRemoteVaultKey: () => this.deps.getRemoteVaultKey(),
    eventGate: this.syncEventGate,
  });
  private readonly syncRequestClient = new SyncAuthorizedRequestClient({
    getApiBaseUrl: () => this.deps.getApiBaseUrl(),
    getSyncToken: async () => await this.deps.getSyncToken(),
    invalidateSyncToken: () => this.deps.invalidateSyncToken(),
  });
  private readonly syncPushService = new SyncPushService({
    getApiBaseUrl: () => this.deps.getApiBaseUrl(),
    getSyncToken: async () => await this.deps.getSyncToken(),
    getSyncStore: () => this.syncStore,
    getRemoteVaultKey: () => this.deps.getRemoteVaultKey(),
    fileReader: this.vaultAdapter,
    conflictFileWriter: this.vaultAdapter,
    blobClient: new SyncBlobClient(this.syncRequestClient),
    onProgress: async (progress) => {
      this.reportActivityProgress(progress);
    },
    onConflict: (event) => this.deps.notifySyncConflict(event),
    onFileSizeBlockedFilesChange: () => {
      this.deps.onFileSizeBlockedFilesChange?.();
    },
  });
  private readonly syncLocalReconcileService = new SyncLocalReconcileService({
    getSyncStore: () => this.syncStore,
    getRemoteVaultKey: () => this.deps.getRemoteVaultKey(),
    shouldSyncPath: (path) => this.vaultAdapter.isSyncablePath(path),
    scanner: this.vaultAdapter,
  });
  private readonly syncAutoLoop = new SyncAutoLoop({
    getApiBaseUrl: () => this.deps.getApiBaseUrl(),
    getSyncToken: async () => await this.deps.getSyncToken(),
    getSyncStore: () => this.syncStore,
    pushPendingMutations: async (session) =>
      await this.withSyncActivity("push", async () => {
        return await this.syncPushService.pushPendingMutations(session);
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
      await this.withSyncActivity("pull", async () => {
        return await this.syncPullService.pullOnce(session);
      }),
    onConnectionStateChange: (state) => {
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
    onSyncScheduled: () => {
      this.setOnlineSyncStatus("syncing");
    },
    onIdle: () => {
      this.deps.setSyncStatus("up_to_date");
    },
    onError: (error) => {
      if (isOfflineLikeError(error, this.deps.isOffline)) {
        this.deps.setSyncStatus("offline");
        return;
      }

      this.deps.setSyncStatus("attention_needed");
      this.deps.notifyError(error, "Auto sync failed");
    },
    onRemoteVaultUnavailable: async (error) => {
      await this.deps.onRemoteVaultUnavailable?.(error);
    },
    onStorageQuotaExceeded: async () => {
      await this.deps.onStorageQuotaExceeded?.();
    },
  });
  private readonly syncVaultEventHandler = new SyncVaultEventHandler({
    plugin: this.deps.plugin,
    vaultAdapter: this.vaultAdapter,
    eventRecorder: this.syncEventRecorder,
    autoLoop: this.syncAutoLoop,
    runLocalMutationWork: async (work) => await this.runLocalMutationWork(work),
    hasActiveRemoteVaultSession: () => this.deps.hasActiveRemoteVaultSession(),
    onError: (error) => {
      this.deps.setSyncStatus("attention_needed");
      this.deps.notifyError(error, "Sync event handling failed");
    },
  });
  private readonly syncPullService = new SyncPullService({
    getApiBaseUrl: () => this.deps.getApiBaseUrl(),
    getSyncToken: async () => await this.deps.getSyncToken(),
    getSyncStore: () => this.syncStore,
    getRemoteVaultKey: () => this.deps.getRemoteVaultKey(),
    eventGate: this.syncEventGate,
    vaultAdapter: this.vaultAdapter,
    pullClient: new SyncPullClient(this.syncRequestClient),
    onProgress: async (progress) => {
      this.reportActivityProgress(progress);
    },
    onConflict: (event) => this.deps.notifySyncConflict(event),
  });
  private readonly syncVersionHistoryService = new SyncVersionHistoryService({
    getApiBaseUrl: () => this.deps.getApiBaseUrl(),
    getSyncToken: async () => await this.deps.getSyncToken(),
    getStore: () => this.requireStore(),
    getRemoteVaultKey: () => this.deps.getRemoteVaultKey(),
    pullClient: new SyncPullClient(this.syncRequestClient),
    withRealtimeSession: async (work) => await this.withRealtimeSession(work),
    runLocalMutationWork: async (work) => await this.runLocalMutationWork(work),
    pullOnce: async (session) => {
      await this.withSyncActivity("pull", async () => {
        await this.syncPullService.pullOnce(session);
      });
    },
  });
  constructor(private readonly deps: SyncEngineDeps) {}

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

  async readLocalVaultId(): Promise<string> {
    return (await readStoredSyncConnection(this.requireStore()))?.localVaultId ?? "";
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
    if (this.deps.getSyncFileRules().includedHiddenFolders.length > 0) {
      this.startHiddenFolderReconcileTimer();
      return;
    }

    this.stopHiddenFolderReconcileTimer();
  }

  registerVaultEvents(): void {
    this.syncVaultEventHandler.register();
  }

  notifyLocalChange(): void {
    this.syncAutoLoop.notifyLocalChange();
  }

  setStorageStatusWatching(enabled: boolean): void {
    this.syncAutoLoop.setStorageStatusWatching(enabled);
  }

  async reconcileOnce(): Promise<ReconcileOnceResult> {
    return await this.runLocalMutationWork(async () => {
      return await this.syncLocalReconcileService.reconcileOnce();
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
      this.deps.getSyncFileRules().includedHiddenFolders.length === 0
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
      this.deps.getSyncFileRules().includedHiddenFolders.length === 0 ||
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
      this.deps.setSyncStatus("attention_needed");
      this.deps.notifyError(error, "Hidden folder scan failed");
    }
  }

  async listFileSizeBlockedFiles(): Promise<SyncFileSizeBlockedFile[]> {
    const store = this.syncStore;
    if (!store) {
      return [];
    }

    const mutations = await store.listBlockedDirtyEntriesByReason("file_too_large");
    const remoteVaultKey = this.deps.getRemoteVaultKey();
    const files: SyncFileSizeBlockedFile[] = [];
    for (const mutation of mutations) {
      if (mutation.op !== "upsert") {
        continue;
      }

      const metadata = await decryptSyncMetadata(
        remoteVaultKey,
        mutation.encryptedMetadata,
        metadataContextFromMutation(mutation),
      );
      files.push({
        path: metadata.path,
        encryptedSizeBytes: mutation.blockedEncryptedSizeBytes ?? null,
        maxFileSizeBytes: mutation.blockedMaxFileSizeBytes ?? null,
      });
    }

    return files;
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
    const run = this.localMutationQueue.then(
      () => this.withSyncActivity("local", work),
      () => this.withSyncActivity("local", work),
    );
    this.localMutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async withSyncActivity<T>(
    kind: SyncActivityKind,
    work: () => Promise<T>,
  ): Promise<T> {
    const activity = this.beginSyncActivity(kind);
    try {
      return await work();
    } finally {
      await this.finishSyncActivity(activity);
    }
  }

  private beginSyncActivity(kind: SyncActivityKind): ActiveSyncActivity {
    const activity = {
      id: this.nextSyncActivityId,
      kind,
    };
    this.nextSyncActivityId += 1;
    this.activeSyncActivities.push(activity);
    return activity;
  }

  private async finishSyncActivity(activity: ActiveSyncActivity): Promise<void> {
    this.activeSyncActivities = this.activeSyncActivities.filter(
      (activeActivity) => activeActivity.id !== activity.id,
    );
    await this.refreshSyncProgress();
  }

  private reportActivityProgress(progress: UserVisibleSyncProgress): void {
    if (!this.hasActiveRemoteActivity()) {
      return;
    }

    this.deps.setSyncProgress(progress);
  }

  private reportBaselineProgress(progress: UserVisibleSyncProgress): void {
    if (this.activeSyncActivities.length === 0) {
      this.deps.setSyncProgress(progress);
    }
  }

  private hasActiveRemoteActivity(): boolean {
    return this.activeSyncActivities.some((activity) => activity.kind !== "local");
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

export type SyncEngineEntryVersionsPage = SyncEntryVersionsPage;

export interface SyncFileSizeBlockedFile {
  path: string;
  encryptedSizeBytes: number | null;
  maxFileSizeBytes: number | null;
}
