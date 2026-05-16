import { Notice, type Plugin } from "obsidian";

import {
  isOffline as detectOffline,
  isOfflineLikeError,
  type OfflineDetector,
} from "../../http/network-status";
import {
  isRemoteVaultUnavailableError,
  type RemoteVaultUnavailableError,
} from "../../remote-vault/unavailable";
import type { SyncTokenResponse } from "../remote/client";
import type {
  DeletedEntryPageCursor,
  EntryVersion,
  EntryVersionPageCursor,
  SyncStorageStatus,
} from "../remote/realtime-client";
import type { SyncFileRules } from "../core/file-rules";
import type { VaultConfigSyncRules } from "../core/vault-config-rules";
import {
  clearDexieSyncStore,
  createDexieSyncStore,
  readDexieSyncStoreConnection,
} from "../store/dexie";
import type { SyncConnection } from "../store/store";
import type { SyncDeletedEntriesPage } from "./version-history-service";
import type { SyncDeletedEntriesRestoreResult } from "./version-history-service";
import type { SyncDeletedEntriesPurgeResult } from "./version-history-service";
import {
  SyncEngine,
  type SyncEngineEntryVersionsPage,
  type SyncFileSizeBlockedFile,
} from "./engine";
import type { SyncEntryVersionPreview } from "./version-history-service";
import {
  formatUserVisibleSyncState,
  getUserVisibleSyncDisplayPercent,
  type UserVisibleSyncProgress,
  type UserVisibleSyncState,
} from "./user-visible-status";

export interface SyncControllerDeps {
  plugin: Plugin;
  getApiBaseUrl: () => string;
  getSyncToken: () => Promise<SyncTokenResponse>;
  invalidateSyncToken: () => void;
  getRemoteVaultKey: () => Uint8Array;
  getSyncFileRules: () => SyncFileRules;
  getVaultConfigSyncRules: () => VaultConfigSyncRules;
  hasActiveRemoteVaultSession: () => boolean;
  hasConnectedRemoteVault: () => boolean;
  hasAuthenticatedSession: () => boolean;
  notifyError: (error: unknown, prefix: string) => void;
  notify?: (message: string, timeout?: number) => void;
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
  private syncProgress: UserVisibleSyncProgress = {
    completedEntries: 0,
    totalEntries: 0,
  };
  private readonly syncEngine = new SyncEngine({
    plugin: this.deps.plugin,
    getApiBaseUrl: () => this.deps.getApiBaseUrl(),
    getSyncToken: async () => await this.deps.getSyncToken(),
    invalidateSyncToken: () => this.deps.invalidateSyncToken(),
    getRemoteVaultKey: () => this.deps.getRemoteVaultKey(),
    getSyncFileRules: () => this.deps.getSyncFileRules(),
    getVaultConfigSyncRules: () => this.deps.getVaultConfigSyncRules(),
    hasActiveRemoteVaultSession: () => this.deps.hasActiveRemoteVaultSession(),
    notify: (message, timeout) => this.notify(message, timeout),
    notifyError: (error, prefix) => this.deps.notifyError(error, prefix),
    notifySyncConflict: (event) => this.notifySyncConflict(event),
    setSyncProgress: (progress) => this.setSyncProgress(progress),
    setSyncStatus: (status) => this.setSyncStatus(status),
    setStorageStatus: (status) => this.setStorageStatus(status),
    onFileSizeBlockedFilesChange: () => {
      this.deps.onFileSizeBlockedFilesChange?.();
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
      this.deps.notifyError(error, "Local sync store initialization failed");
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.syncEngine.setStorageStatusWatching(false);
    this.syncEngine.stopAutoSync();
    this.setStorageStatus(null);
    await this.syncEngine.closeStore();
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
    this.syncEngine.setStorageStatusWatching(false);
    this.syncEngine.stopAutoSync();
    this.setStorageStatus(null);
    this.setSyncProgress({
      completedEntries: 0,
      totalEntries: 0,
    });
    this.setSyncStatus("not_ready");
  }

  stopAutoSyncAndMarkPaused(): void {
    this.syncEngine.setStorageStatusWatching(false);
    this.syncEngine.stopAutoSync();
    this.setStorageStatus(null);
    this.setSyncStatus("paused");
  }

  async resetLocalSyncState(): Promise<void> {
    this.syncEngine.setStorageStatusWatching(false);
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

  getSyncStatusLabel(): string {
    return formatUserVisibleSyncState(this.syncStatus, this.syncProgress);
  }

  getSyncState(): UserVisibleSyncState {
    return this.syncStatus;
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

  async ensureAutoSyncState(): Promise<void> {
    if (!this.deps.hasActiveRemoteVaultSession() || !this.deps.hasAuthenticatedSession()) {
      this.syncEngine.setStorageStatusWatching(false);
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

    try {
      this.syncEngine.setStorageStatusWatching(true);
      const reconcile = await this.syncEngine.reconcileOnce();
      await this.syncEngine.waitForLocalMutationWork();
      await this.syncEngine.startAutoSync();
      const hasPendingMutations = await this.syncEngine.hasPendingMutations();
      if (
        hasPendingMutations ||
        reconcile.filesQueuedForUpsert > 0 ||
        reconcile.filesQueuedForDelete > 0
      ) {
        this.syncEngine.notifyLocalChange();
      }
    } catch (error) {
      this.syncEngine.setStorageStatusWatching(false);
      this.setStorageStatus(null);
      if (isRemoteVaultUnavailableError(error)) {
        await this.handleRemoteVaultUnavailable(error);
        return;
      }

      if (isOfflineLikeError(error, this.deps.isOffline)) {
        this.setSyncStatus("offline");
        return;
      }

      this.setSyncStatus("attention_needed");
      this.deps.notifyError(error, "Auto sync initialization failed");
    }
  }

  async resumeAutoSync(): Promise<void> {
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

    this.syncEngine.setStorageStatusWatching(true);
    const started = await this.syncEngine.startAutoSync();
    if (!started) {
      await this.syncEngine.resumeAutoSyncConnection();
    }
  }

  registerVaultEvents(): void {
    this.syncEngine.registerVaultEvents();
  }

  async reconcileAfterFileRuleChange(): Promise<void> {
    if (!this.deps.hasActiveRemoteVaultSession() || !this.syncEngine.hasStore()) {
      return;
    }

    try {
      this.setSyncStatus("syncing");
      await this.syncEngine.reapplyAllowedRemoteVaultConfig();
      await this.syncEngine.reconcileOnce();
      this.syncEngine.refreshHiddenFolderReconcileTimer();
      this.syncEngine.notifyLocalChange();
    } catch (error) {
      if (isRemoteVaultUnavailableError(error)) {
        await this.handleRemoteVaultUnavailable(error);
        return;
      }

      if (isOfflineLikeError(error, this.deps.isOffline)) {
        this.setSyncStatus("offline");
        return;
      }

      this.setSyncStatus("attention_needed");
      this.deps.notifyError(error, "Sync file rule update failed");
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

  private setSyncProgress(progress: UserVisibleSyncProgress | null): void {
    if (!progress) {
      return;
    }

    const normalized =
      progress.totalEntries > 0
        ? {
            completedEntries: Math.max(0, progress.completedEntries),
            totalEntries: Math.max(0, progress.totalEntries),
          }
        : {
            completedEntries: 0,
            totalEntries: 0,
          };

    if (
      this.syncProgress?.completedEntries === normalized?.completedEntries &&
      this.syncProgress?.totalEntries === normalized?.totalEntries
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
    this.stopAutoSyncAndMarkNotReady();
    await this.deps.onRemoteVaultUnavailable?.(error);
  }

  private notifySyncConflict(event: {
    op: "upsert" | "delete";
    reason?: "local_pending_mutation" | "remote_path_collision";
    originalPath: string;
    conflictPath: string | null;
  }): void {
    if (event.reason === "remote_path_collision" && event.conflictPath) {
      this.notify(
        `Sync path collision detected. The remote file was saved to "${event.conflictPath}".`,
      );
      return;
    }

    if (event.op === "upsert" && event.conflictPath) {
      this.notify(
        `Sync conflict detected. Your local changes were saved to "${event.conflictPath}".`,
      );
      return;
    }

    this.notify(
      `Sync conflict detected for "${event.originalPath}". The remote version will be kept.`,
    );
  }

  private shouldShowOfflineBeforeReady(): boolean {
    return (
      this.deps.hasAuthenticatedSession() &&
      this.deps.hasConnectedRemoteVault() &&
      (this.syncStatus === "offline" || detectOffline(this.deps.isOffline))
    );
  }
}
