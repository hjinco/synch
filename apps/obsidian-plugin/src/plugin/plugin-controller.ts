import { Notice, type Plugin, TFolder } from "obsidian";

import { BillingClient } from "../billing/client";
import { buildBillingWebPageUrl } from "../billing/web-url";
import { getDefaultApiBaseUrl } from "../config";
import { isOfflineLikeError } from "../http/network-status";
import { getSynchLocale, t } from "../i18n";
import { AuthManager, type AuthReadiness } from "../auth/manager";
import { SynchPluginDataStore } from "../plugin-data";
import type { SynchSettingsController } from "../settings/controller";
import { SynchSettingsStore } from "../settings/store";
import { SynchRemoteVaultController } from "./remote-vault-controller";
import { SynchVersionHistoryController } from "./version-history-controller";
import type { SynchUiEvent } from "./ui-events";
import type { VersionHistoryViewState } from "./version-history-view";
import type {
  SynchDeletedFile,
  SynchDeletedFileCursor,
  SynchDeletedFilesPage,
  SynchDeletedFilesPurgeResult,
  SynchDeletedFilesRestoreResult,
  SynchEntryVersionCursor,
  SynchFileSizeBlockedFile,
  SynchFileRules,
  SynchPluginUpdateStatus,
  SynchStorageStatus,
  SynchSubscriptionStatus,
  SynchSyncProgress,
  SynchSyncState,
  SynchVersionPreview,
} from "./view-models";
import {
  SUPPORTED_SYNCH_API_MAJOR,
  SynchServerPluginVersionChecker,
} from "./server-version-checker";
import { SynchPluginUpdateChecker } from "./update-checker";
import {
  normalizeExcludedFolders,
  normalizeIncludedHiddenFolders,
  normalizeVaultPath,
  type SyncFileRules,
} from "../sync/core/file-rules";
import { isReservedSyncPath } from "../sync/core/reserved-paths";
import type { SyncTokenResponse } from "../sync/remote/client";
import { SyncController } from "../sync/runtime/controller";
import { SyncTokenManager } from "../sync/remote/token-manager";
import type { StoredRemoteVaultKeySecret } from "../remote-vault/device-storage";
import {
  clearStoredRemoteVaultKeySecret,
  readStoredRemoteVaultKeySecret,
  writeStoredRemoteVaultKeySecret,
} from "../remote-vault/device-storage";
import { RemoteVaultManager } from "../remote-vault/manager";
import {
  isRemoteVaultUnavailableError,
  type RemoteVaultUnavailableError,
} from "../remote-vault/unavailable";
import type { SyncConnection } from "../sync/store/store";

const PLUGIN_UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const SUBSCRIPTION_STATUS_CHECK_INTERVAL_MS = 30 * 1000;

export interface SynchPluginControllerDeps {
  plugin: Plugin;
  refreshUi: () => void;
  emitUiEvent?: (event: SynchUiEvent) => void;
}

export class SynchPluginController implements SynchSettingsController {
  private readonly plugin = this.deps.plugin;
  private readonly pluginDataStore = new SynchPluginDataStore(this.plugin);
  private readonly settingsStore = new SynchSettingsStore(this.pluginDataStore);
  private readonly billingClient = new BillingClient();
  private readonly pluginUpdateChecker = new SynchPluginUpdateChecker();
  private readonly serverPluginVersionChecker = new SynchServerPluginVersionChecker();
  private pluginUpdateCheckPromise: Promise<void> | null = null;
  private pluginUpdateCheckedAt = 0;
  private subscriptionStatusCheckPromise: Promise<void> | null = null;
  private subscriptionStatusCheckedAt = 0;
  private pluginUpdateStatus: SynchPluginUpdateStatus = {
    state: "idle",
    currentVersion: this.plugin.manifest.version,
  };
  private subscriptionStatus: SynchSubscriptionStatus = {
    state: "idle",
  };
  private storedRemoteVaultKeySecret: StoredRemoteVaultKeySecret | null = null;
  private storedSyncConnection: SyncConnection | null = null;
  private remoteVaultSyncFormatVersion: number | null = null;
  private resumeAutoSyncPromise: Promise<void> | null = null;
  private remoteVaultUnavailableDisconnectPromise: Promise<void> | null = null;
  private readonly authManager = new AuthManager({
    plugin: this.plugin,
    getApiBaseUrl: () => this.getApiBaseUrl(),
    refreshUi: () => {
      this.refreshUi();
    },
  });
  private readonly remoteVaultManager = new RemoteVaultManager({
    getApiBaseUrl: () => this.getApiBaseUrl(),
    getAuthSessionToken: () => this.authManager.getAuthSessionToken(),
    hasAuthenticatedSession: () => this.authManager.hasAuthenticatedSession(),
    getStoredRemoteVaultId: () => this.storedSyncConnection?.remoteVaultId ?? null,
    getStoredRemoteVaultKeySecret: () => this.storedRemoteVaultKeySecret,
    saveStoredRemoteVaultKeySecret: async (vault) => {
      await this.saveStoredRemoteVaultKeySecret(vault);
    },
    refreshUi: () => {
      this.refreshUi();
    },
    notify: (message) => {
      new Notice(message);
    },
  });
  private readonly syncTokenManager = new SyncTokenManager({
    getApiBaseUrl: () => this.getApiBaseUrl(),
    getAuthSessionToken: () => this.authManager.getAuthSessionToken(),
    getRemoteVaultId: () => this.remoteVaultManager.getRemoteVaultId(),
    getLocalVaultId: async () => await this.syncController.readLocalVaultId(),
  });
  private readonly syncController = new SyncController({
    plugin: this.plugin,
    getApiBaseUrl: () => this.getApiBaseUrl(),
    getSyncToken: async () => await this.getSyncTokenForActiveRemoteVault(),
    invalidateSyncToken: () => {
      this.clearSyncTokenState();
    },
    getRemoteVaultKey: () => this.getActiveRemoteVaultKey(),
    getSyncFileRules: () => this.getSyncFileRules(),
    hasActiveRemoteVaultSession: () => this.hasActiveRemoteVaultSession(),
    hasConnectedRemoteVault: () => this.hasConnectedRemoteVault(),
    hasAuthenticatedSession: () => this.hasAuthenticatedSession(),
    notifyError: (error, prefix) => {
      this.notifyError(error, prefix);
    },
    notify: (message, timeout) => {
      new Notice(message, timeout);
    },
    onSyncStatusChange: () => {
      this.emitUiEvent({ type: "sync-status-changed" });
    },
    onStorageStatusChange: () => {
      this.emitUiEvent({ type: "storage-status-changed" });
    },
    onFileSizeBlockedFilesChange: () => {
      this.emitUiEvent({ type: "file-size-blocked-changed" });
    },
    onStorageQuotaExceeded: async () => {
      await this.setSyncEnabled(false);
      new Notice("Storage quota exceeded. Sync has been paused.");
    },
    onRemoteVaultUnavailable: async (error) => {
      await this.disconnectUnavailableRemoteVault(error);
    },
  });
  private readonly versionHistoryController = new SynchVersionHistoryController({
    plugin: this.plugin,
    syncController: this.syncController,
    getSyncFileRules: () => this.getSyncFileRules(),
    hasAuthenticatedSession: () => this.hasAuthenticatedSession(),
    hasConnectedRemoteVault: () => this.hasConnectedRemoteVault(),
    refreshUi: () => this.refreshUi(),
  });
  private readonly remoteVaultController = new SynchRemoteVaultController({
    plugin: this.plugin,
    remoteVaultManager: this.remoteVaultManager,
    syncController: this.syncController,
    clearSyncTokenState: () => {
      this.clearSyncTokenState();
    },
    getApiBaseUrl: () => this.getApiBaseUrl(),
    getSyncFileRules: () => this.getSyncFileRules(),
    getStoredRemoteVaultId: () => this.storedSyncConnection?.remoteVaultId ?? null,
    hasConnectedRemoteVault: () => this.hasConnectedRemoteVault(),
    initializeSyncStoreForActiveRemoteVault: async () => {
      await this.initializeSyncStoreForActiveRemoteVault();
    },
    ensureAutoSyncState: async () => {
      await this.ensureAutoSyncState();
    },
    resetSyncConnection: async () => {
      await this.resetSyncConnection();
    },
    notifyError: (error, prefix) => {
      this.notifyError(error, prefix);
    },
  });

  constructor(private readonly deps: SynchPluginControllerDeps) {}

  async initialize(): Promise<void> {
    await this.pluginDataStore.initialize();
    await this.initializeSettings();
    await this.checkServerPluginVersion();
    this.storedRemoteVaultKeySecret = await readStoredRemoteVaultKeySecret(this.plugin);
    this.storedSyncConnection = await this.syncController.readStoredConnection();
    await this.authManager.initialize();
  }

  async stop(): Promise<void> {
    await this.syncController.stop();
  }

  registerVaultEvents(): void {
    if (this.isPluginUpdateRequired()) {
      return;
    }

    this.syncController.registerVaultEvents();
  }

  ensureAutoSyncState(): Promise<void> {
    // Startup and reconnect both pass through this readiness pipeline so that
    // offline auth verification, vault restore, and sync startup stay ordered.
    return this.reconcileReadiness();
  }

  queueAutoSyncResume(): void {
    if (this.resumeAutoSyncPromise) {
      return;
    }

    this.resumeAutoSyncPromise = this.resumeAutoSyncWhenPossible()
      .catch((error) => {
        this.notifyUnlessOffline(error, "Auto sync resume failed");
      })
      .finally(() => {
        this.resumeAutoSyncPromise = null;
      });
  }

  getPluginUpdateStatus(): SynchPluginUpdateStatus {
    return this.pluginUpdateStatus;
  }

  async ensurePluginUpdateCheck(): Promise<void> {
    if (this.isPluginUpdateRequired()) {
      return;
    }

    if (this.pluginUpdateCheckPromise) {
      await this.pluginUpdateCheckPromise;
      return;
    }

    if (
      this.pluginUpdateStatus.state !== "idle" &&
      Date.now() - this.pluginUpdateCheckedAt < PLUGIN_UPDATE_CHECK_INTERVAL_MS
    ) {
      return;
    }

    await this.checkPluginUpdate();
  }

  async retryPluginUpdateCheck(): Promise<void> {
    if (this.isPluginUpdateRequired()) {
      return;
    }

    await this.checkPluginUpdate();
  }

  getSubscriptionStatus(): SynchSubscriptionStatus {
    return this.subscriptionStatus;
  }

  async ensureSubscriptionStatusCheck(): Promise<void> {
    if (!this.hasAuthenticatedSession() || !this.usesDefaultApiBaseUrl()) {
      this.clearSubscriptionStatus();
      return;
    }

    if (this.subscriptionStatusCheckPromise) {
      await this.subscriptionStatusCheckPromise;
      return;
    }

    if (
      this.subscriptionStatus.state !== "idle" &&
      Date.now() - this.subscriptionStatusCheckedAt < SUBSCRIPTION_STATUS_CHECK_INTERVAL_MS
    ) {
      return;
    }

    await this.checkSubscriptionStatus();
  }

  async retrySubscriptionStatusCheck(): Promise<void> {
    if (!this.hasAuthenticatedSession() || !this.usesDefaultApiBaseUrl()) {
      this.clearSubscriptionStatus();
      return;
    }

    await this.checkSubscriptionStatus();
  }

  openBillingManagementPage(): void {
    this.openBillingWebPage("billing");
  }

  openPricingPage(): void {
    this.openBillingWebPage("pricing");
  }

  getAuthStatusLabel(): string {
    return this.authManager.getAuthStatusLabel();
  }

  getAuthReadiness(): AuthReadiness {
    return this.authManager.getReadiness();
  }

  hasAuthenticatedSession(): boolean {
    return this.authManager.hasAuthenticatedSession();
  }

  isDeviceLoginInProgress(): boolean {
    return this.authManager.isDeviceLoginInProgress();
  }

  getRemoteVaultStatusLabel(): string {
    return this.remoteVaultManager.getRemoteVaultStatusLabel();
  }

  getRemoteVaultSyncFormatVersion(): number | null {
    return this.remoteVaultSyncFormatVersion;
  }

  hasConnectedRemoteVault(): boolean {
    return this.remoteVaultManager.hasConnectedRemoteVault();
  }

  getSyncStatusLabel(): string {
    if (this.isPluginUpdateRequired()) {
      return t("plugin.updateRequiredStatus");
    }

    return this.syncController.getSyncStatusLabel();
  }

  getSyncState(): SynchSyncState {
    if (this.isPluginUpdateRequired()) {
      return "update_required";
    }

    return this.syncController.getSyncState();
  }

  getSyncPercent(): number {
    return this.syncController.getSyncPercent();
  }

  getSyncProgress(): SynchSyncProgress {
    return this.syncController.getSyncProgress();
  }

  isSyncEnabled(): boolean {
    return this.settingsStore.getSnapshot().syncEnabled;
  }

  async setSyncEnabled(enabled: boolean): Promise<void> {
    if (enabled && this.isPluginUpdateRequired()) {
      new Notice(this.getPluginUpdateRequiredMessage());
      this.syncController.stopAutoSyncAndMarkNotReady();
      this.refreshUi();
      return;
    }

    const changed = await this.settingsStore.updateSyncEnabled(enabled);
    if (!enabled) {
      this.syncController.stopAutoSyncAndMarkPaused();
      if (changed) {
        this.refreshUi();
      }
      return;
    }

    if (changed) {
      this.refreshUi();
    }
    await this.ensureAutoSyncState();
  }

  getStorageStatus(): SynchStorageStatus | null {
    return this.syncController.getStorageStatus();
  }

  getApiBaseUrl(): string {
    return this.settingsStore.getSnapshot().apiBaseUrl;
  }

  watchStorageStatus(): void {
    this.syncController.watchStorageStatus();
  }

  unwatchStorageStatus(): void {
    this.syncController.unwatchStorageStatus();
  }

  getSyncFileRules(): SynchFileRules {
    return this.settingsStore.getSnapshot().fileRules;
  }

  listSelectableExcludedFolderPaths(): string[] {
    return this.plugin.app.vault
      .getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder)
      .map((folder) => folder.path)
      .filter((path) => path.length > 0)
      .filter((path) => !path.split("/").some((segment) => segment.startsWith(".")))
      .sort((left, right) => left.localeCompare(right));
  }

  async updateSyncFileRule<K extends keyof SynchFileRules>(
    key: K,
    value: SynchFileRules[K],
  ): Promise<void> {
    await this.updateSyncFileRules({
      ...this.getSyncFileRules(),
      [key]: value,
    });
  }

  async updateExcludedFolders(paths: string[]): Promise<void> {
    await this.updateSyncFileRules({
      ...this.getSyncFileRules(),
      excludedFolders: normalizeExcludedFolders(paths),
    });
  }

  async updateIncludedHiddenFolders(paths: string[]): Promise<void> {
    await this.updateSyncFileRules({
      ...this.getSyncFileRules(),
      includedHiddenFolders: normalizeIncludedHiddenFolders(paths),
    });
  }

  async listSelectableIncludedHiddenFolderPaths(): Promise<string[]> {
    const folders: string[] = [];
    await this.collectSelectableHiddenFolders("", folders);
    return folders.sort((left, right) => left.localeCompare(right));
  }

  async updateApiBaseUrl(value: string): Promise<void> {
    if (this.hasAuthenticatedSession()) {
      throw new Error("Sign out before changing the API server.");
    }
    if (this.isDeviceLoginInProgress()) {
      throw new Error("Finish or cancel sign-in before changing the API server.");
    }
    if (this.hasConnectedRemoteVault()) {
      throw new Error("Disconnect the current vault before changing the API server.");
    }

    const changed = await this.settingsStore.updateApiBaseUrl(value);
    if (changed) {
      this.refreshUi();
    }
  }

  async getSyncTokenForActiveRemoteVault(): Promise<SyncTokenResponse> {
    let token: SyncTokenResponse;
    try {
      token = await this.syncTokenManager.getTokenForActiveRemoteVault();
    } catch (error) {
      if (isRemoteVaultUnavailableError(error)) {
        await this.disconnectUnavailableRemoteVault(error);
      }
      throw error;
    }

    if (this.remoteVaultSyncFormatVersion !== token.syncFormatVersion) {
      this.remoteVaultSyncFormatVersion = token.syncFormatVersion;
      this.refreshUi();
    }
    return token;
  }

  async beginDeviceLogin(): Promise<void> {
    let loginStarted = false;

    try {
      loginStarted = await this.authManager.beginDeviceLogin();
    } finally {
      if (loginStarted) {
        this.clearSubscriptionStatus();
        this.clearSyncTokenState();
        await this.ensureAutoSyncState();
      }
    }
  }

  async signOutDevice(): Promise<void> {
    try {
      await this.remoteVaultController.disconnectRemoteVault();
      await this.authManager.signOutDevice();
    } finally {
      this.clearSubscriptionStatus();
      this.clearSyncTokenState();
      this.remoteVaultManager.clearSession();
      await this.saveStoredRemoteVaultKeySecret(null);
      await this.resetSyncConnection();
    }
  }

  private clearSyncTokenState(): void {
    this.syncTokenManager.clear();
    this.remoteVaultSyncFormatVersion = null;
  }

  async createRemoteVaultFromPrompt(): Promise<void> {
    await this.remoteVaultController.createRemoteVaultFromPrompt();
  }

  async connectRemoteVaultFromPrompt(): Promise<void> {
    await this.remoteVaultController.connectRemoteVaultFromPrompt();
  }

  openRemoteVaultManagementPage(): void {
    this.remoteVaultController.openRemoteVaultManagementPage();
  }

  async disconnectRemoteVault(): Promise<void> {
    await this.remoteVaultController.disconnectRemoteVault();
  }

  async openVersionHistoryPane(): Promise<void> {
    await this.versionHistoryController.openPane();
  }

  async ensureVersionHistoryPane(): Promise<void> {
    await this.versionHistoryController.ensurePane();
  }

  async listActiveFileVersions(
    before: SynchEntryVersionCursor | null,
    limit: number,
  ): Promise<VersionHistoryViewState> {
    return await this.versionHistoryController.listActiveFileVersions(before, limit);
  }

  async previewActiveFileVersion(versionId: string): Promise<SynchVersionPreview> {
    return await this.versionHistoryController.previewActiveFileVersion(versionId);
  }

  async restoreActiveFileVersion(versionId: string): Promise<void> {
    await this.versionHistoryController.restoreActiveFileVersion(versionId);
  }

  async listDeletedFiles(
    before: SynchDeletedFileCursor | null,
    limit: number,
  ): Promise<SynchDeletedFilesPage> {
    return await this.versionHistoryController.listDeletedFiles(before, limit);
  }

  async listFileSizeBlockedFiles(): Promise<SynchFileSizeBlockedFile[]> {
    return await this.syncController.listFileSizeBlockedFiles();
  }

  async previewDeletedFile(
    entryId: string,
    fallbackPath: string,
  ): Promise<SynchVersionPreview> {
    return await this.versionHistoryController.previewDeletedFile(
      entryId,
      fallbackPath,
    );
  }

  async restoreDeletedFiles(
    files: SynchDeletedFile[],
  ): Promise<SynchDeletedFilesRestoreResult> {
    return await this.versionHistoryController.restoreDeletedFiles(files);
  }

  async purgeDeletedFiles(
    files: SynchDeletedFile[],
  ): Promise<SynchDeletedFilesPurgeResult> {
    return await this.versionHistoryController.purgeDeletedFiles(files);
  }

  refreshVersionHistoryViews(): void {
    this.versionHistoryController.refreshViews();
  }

  private refreshUi(): void {
    this.deps.refreshUi();
  }

  private emitUiEvent(event: SynchUiEvent): void {
    if (this.deps.emitUiEvent) {
      this.deps.emitUiEvent(event);
      return;
    }

    this.refreshUi();
  }

  private async checkPluginUpdate(): Promise<void> {
    if (this.isPluginUpdateRequired()) {
      return;
    }

    if (this.pluginUpdateCheckPromise) {
      await this.pluginUpdateCheckPromise;
      return;
    }

    this.pluginUpdateStatus = {
      state: "checking",
      currentVersion: this.plugin.manifest.version,
    };
    this.pluginUpdateCheckPromise = this.pluginUpdateChecker
      .check(this.plugin.manifest.version)
      .then((status) => {
        this.pluginUpdateStatus = status;
      })
      .catch((error) => {
        this.pluginUpdateStatus = {
          state: "failed",
          currentVersion: this.plugin.manifest.version,
          error: error instanceof Error ? error.message : String(error),
        };
      })
      .finally(() => {
        this.pluginUpdateCheckedAt = Date.now();
        this.pluginUpdateCheckPromise = null;
        this.refreshUi();
      });

    await this.pluginUpdateCheckPromise;
  }

  private async checkSubscriptionStatus(): Promise<void> {
    if (this.subscriptionStatusCheckPromise) {
      await this.subscriptionStatusCheckPromise;
      return;
    }

    const sessionToken = this.authManager.getAuthSessionToken().trim();
    if (!sessionToken) {
      this.clearSubscriptionStatus();
      return;
    }

    this.subscriptionStatus = { state: "checking" };
    this.subscriptionStatusCheckPromise = this.billingClient
      .readBillingStatus(this.getApiBaseUrl(), sessionToken)
      .then((status) => {
        this.subscriptionStatus = {
          state: "loaded",
          ...status,
        };
      })
      .catch((error) => {
        this.subscriptionStatus = {
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      })
      .finally(() => {
        this.subscriptionStatusCheckedAt = Date.now();
        this.subscriptionStatusCheckPromise = null;
        this.refreshUi();
      });

    await this.subscriptionStatusCheckPromise;
  }

  private clearSubscriptionStatus(): void {
    this.subscriptionStatus = { state: "idle" };
    this.subscriptionStatusCheckedAt = 0;
    this.subscriptionStatusCheckPromise = null;
  }

  private usesDefaultApiBaseUrl(): boolean {
    return this.getApiBaseUrl() === getDefaultApiBaseUrl();
  }

  private openBillingWebPage(page: "pricing" | "billing"): void {
    const url = buildBillingWebPageUrl(this.getApiBaseUrl(), page, getSynchLocale());
    window.open(url, "_blank", "noopener,noreferrer");
  }

  private async saveStoredRemoteVaultKeySecret(
    vault: StoredRemoteVaultKeySecret | null,
  ): Promise<void> {
    this.storedRemoteVaultKeySecret = vault;
    if (vault) {
      await writeStoredRemoteVaultKeySecret(this.plugin, vault);
    } else {
      await clearStoredRemoteVaultKeySecret(this.plugin);
    }
    this.refreshUi();
  }

  private async resumeAutoSyncWhenPossible(): Promise<void> {
    await this.runReadyAutoSync(() => this.syncController.resumeAutoSync());
  }

  private async reconcileReadiness(): Promise<void> {
    await this.runReadyAutoSync(() => this.syncController.ensureAutoSyncState());
  }

  private async runReadyAutoSync(startAutoSync: () => Promise<void>): Promise<void> {
    if (this.isPluginUpdateRequired()) {
      this.syncController.stopAutoSyncAndMarkNotReady();
      return;
    }

    const authReadiness = await this.authManager.refreshReadiness();

    if (authReadiness.state === "pending_network") {
      this.syncController.markOffline();
      return;
    }

    if (authReadiness.state !== "verified") {
      if (!this.isSyncEnabled()) {
        this.syncController.stopAutoSyncAndMarkPaused();
        return;
      }

      this.syncController.stopAutoSyncAndMarkNotReady();
      return;
    }

    let hasActiveRemoteVaultStore = false;
    try {
      hasActiveRemoteVaultStore = await this.ensureActiveRemoteVaultStore();
    } catch (error) {
      this.notifyUnlessOffline(error, "Vault restore failed");
      return;
    }

    if (!hasActiveRemoteVaultStore) {
      this.syncController.stopAutoSyncAndMarkNotReady();
      return;
    }

    if (!this.isSyncEnabled()) {
      this.syncController.stopAutoSyncAndMarkPaused();
      return;
    }

    await startAutoSync();
  }

  private async ensureActiveRemoteVaultStore(): Promise<boolean> {
    if (!this.hasActiveRemoteVaultSession()) {
      try {
        await this.remoteVaultManager.restoreStoredSessionIfNeeded();
      } catch (error) {
        if (isRemoteVaultUnavailableError(error)) {
          await this.disconnectUnavailableRemoteVault(error);
          return false;
        }
        throw error;
      }
    }

    if (!this.hasActiveRemoteVaultSession()) {
      return false;
    }

    if (this.syncController.hasStore()) {
      return true;
    }

    await this.initializeSyncStoreForActiveRemoteVault();
    return this.hasActiveRemoteVaultSession();
  }

  private notifyUnlessOffline(error: unknown, prefix: string): void {
    if (isRemoteVaultUnavailableError(error)) {
      void this.disconnectUnavailableRemoteVault(error);
      return;
    }

    if (isOfflineLikeError(error)) {
      this.syncController.markOffline();
      return;
    }

    this.syncController.markAttentionNeeded();
    this.notifyError(error, prefix);
  }

  private async initializeSyncStoreForActiveRemoteVault(): Promise<void> {
    const remoteVaultId = this.remoteVaultManager.getRemoteVaultId();
    if (!remoteVaultId) {
      return;
    }

    await this.syncController.initializeStore(remoteVaultId);
    this.storedSyncConnection = await this.syncController.readStoredConnection();
    this.emitUiEvent({ type: "file-size-blocked-changed" });
  }

  private async resetSyncConnection(): Promise<void> {
    try {
      await this.syncController.resetLocalSyncState();
      this.storedSyncConnection = null;
    } catch (error) {
      this.notifyError(error, "Local sync state reset failed");
      this.syncController.stopAutoSyncAndMarkNotReady();
    }
  }

  private async disconnectUnavailableRemoteVault(
    error: RemoteVaultUnavailableError,
  ): Promise<void> {
    if (this.remoteVaultUnavailableDisconnectPromise) {
      await this.remoteVaultUnavailableDisconnectPromise;
      return;
    }

    const activeRemoteVaultId = this.remoteVaultManager.getRemoteVaultId();
    const storedRemoteVaultId = this.storedSyncConnection?.remoteVaultId ?? null;
    if (
      activeRemoteVaultId !== error.remoteVaultId &&
      storedRemoteVaultId !== error.remoteVaultId
    ) {
      return;
    }

    this.remoteVaultUnavailableDisconnectPromise =
      this.runUnavailableRemoteVaultDisconnect(error).finally(() => {
        this.remoteVaultUnavailableDisconnectPromise = null;
      });
    await this.remoteVaultUnavailableDisconnectPromise;
  }

  private async runUnavailableRemoteVaultDisconnect(
    error: RemoteVaultUnavailableError,
  ): Promise<void> {
    this.syncController.stopAutoSyncAndMarkNotReady();
    this.clearSyncTokenState();
    await this.remoteVaultManager.disconnectRemoteVault({ notify: false });
    await this.resetSyncConnection();

    const message =
      error.reason === "not_found"
        ? "Remote vault was removed. Synch disconnected this Obsidian vault."
        : "Remote vault access is no longer available. Synch disconnected this Obsidian vault.";
    new Notice(message);
  }

  private notifyError(error: unknown, prefix: string): void {
    const message = error instanceof Error ? error.message : String(error);
    new Notice(`${prefix}: ${message}`);
  }

  private async checkServerPluginVersion(): Promise<void> {
    try {
      const status = await this.serverPluginVersionChecker.check(
        this.getApiBaseUrl(),
        this.plugin.manifest.version,
      );
      if (status.apiMajor !== SUPPORTED_SYNCH_API_MAJOR) {
        this.pluginUpdateStatus = {
          state: "update_required",
          currentVersion: this.plugin.manifest.version,
          minVersion: status.minVersion,
          message:
            "This Synch server is not compatible with this plugin version. Update the server or install a compatible Synch plugin version.",
        };
        this.syncController.stopAutoSyncAndMarkNotReady();
        new Notice(this.getPluginUpdateRequiredMessage(), 0);
        this.refreshUi();
        return;
      }

      if (status.status !== "update_required") {
        return;
      }

      this.pluginUpdateStatus = {
        state: "update_required",
        currentVersion: this.plugin.manifest.version,
        minVersion: status.minVersion,
        message: status.message,
      };
      this.syncController.stopAutoSyncAndMarkNotReady();
      new Notice(this.getPluginUpdateRequiredMessage(), 0);
      this.refreshUi();
    } catch {
      // Only a confirmed server policy response should block sync startup.
    }
  }

  private isPluginUpdateRequired(): boolean {
    return this.pluginUpdateStatus.state === "update_required";
  }

  private getPluginUpdateRequiredMessage(): string {
    if (this.pluginUpdateStatus.state !== "update_required") {
      return "Synch plugin update is required.";
    }

    return this.pluginUpdateStatus.message;
  }

  private getActiveRemoteVaultKey(): Uint8Array {
    const session = this.remoteVaultManager.getActiveSession();
    if (!session) {
      throw new Error("Vault session is not loaded.");
    }

    return session.remoteVaultKey;
  }

  private async initializeSettings(): Promise<void> {
    try {
      this.settingsStore.initialize();
    } catch (error) {
      this.notifyError(error, "Plugin settings initialization failed");
    }
  }

  private async updateSyncFileRules(nextRules: SyncFileRules): Promise<void> {
    const changed = await this.settingsStore.updateFileRules(nextRules);
    if (!changed) {
      return;
    }

    this.refreshUi();
    if (!this.isSyncEnabled()) {
      this.syncController.stopAutoSyncAndMarkPaused();
      return;
    }

    await this.syncController.reconcileAfterFileRuleChange();
  }

  private hasActiveRemoteVaultSession(): boolean {
    return this.remoteVaultManager.getActiveSession() !== null;
  }

  private async collectSelectableHiddenFolders(
    folder: string,
    result: string[],
  ): Promise<void> {
    let listed: { folders: string[] };
    try {
      listed = await this.plugin.app.vault.adapter.list(folder);
    } catch {
      return;
    }

    for (const child of listed.folders) {
      const normalized = normalizeVaultPath(child);
      if (!normalized || isReservedSyncPath(normalized)) {
        continue;
      }

      if (normalized.split("/").some((segment) => segment.startsWith("."))) {
        result.push(normalized);
      }

      await this.collectSelectableHiddenFolders(normalized, result);
    }
  }
}
