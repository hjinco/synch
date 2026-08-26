import { Notice, type Plugin, TFolder } from "obsidian";

import { SynchReadinessCoordinator } from "./readiness-coordinator";
import { SynchPluginSessionStore } from "./session-store";
import { SynchSubscriptionService } from "./subscription-service";
import { SynchPluginUpdateService } from "./update-service";
import { defaultHttpClient } from "../adapters/http";
import { AuthClient } from "@synch/sync-client/auth/client";
import { RemoteVaultClient } from "@synch/sync-client/remote-vault/client";
import { SyncAccessClient } from "@synch/sync-client/sync/remote/client";
import { getSynchLocale, t, type SynchErrorContextKey } from "../i18n";
import { formatSynchErrorNotice } from "./status/error-notices";
import { formatAuthNotice, formatAuthStatusLabel } from "./status/auth-status-label";
import {
  formatRemoteVaultNotice,
  formatRemoteVaultStatusLabel,
} from "./status/remote-vault-status-label";
import { AuthManager, type AuthReadiness } from "@synch/sync-client/auth/manager";
import { ObsidianAuthSessionTokenStore } from "../adapters/auth-session-storage";
import { SynchPluginDataStore } from "../adapters/plugin-data";
import type { SynchSettingsController } from "../ui/settings/controller";
import { SynchSettingsStore } from "../settings/store";
import { SynchRemoteVaultController } from "../ui/remote-vault/remote-vault-controller";
import { SynchVersionHistoryController } from "../ui/version-history/version-history-controller";
import type { SynchUiEvent } from "../ui/ui-events";
import type { VersionHistoryViewState } from "../ui/version-history/version-history-view";
import type {
  SynchDeletedFile,
  SynchDeletedFileCursor,
  SynchDeletedFilesPage,
  SynchDeletedFilesPurgeResult,
  SynchDeletedFilesRestoreResult,
  SynchEntryVersionCursor,
  SynchFileSizeBlockedFile,
  SynchFileRules,
  SynchCommunityPluginUpdateStatus,
  SynchServerCompatibilityStatus,
  SynchStorageStatus,
  SynchSubscriptionStatus,
  SynchSyncLogs,
  SynchSyncProgress,
  SynchSyncState,
  SynchVaultConfigSyncRules,
  SynchVersionPreview,
} from "../ui/contracts";
import {
  normalizeSyncFileRules,
  normalizeVaultPath,
  type SyncFileRules,
} from "@synch/sync-client/sync/core/file-rules";
import { isReservedSyncPath } from "@synch/sync-client/sync/core/reserved-paths";
import type { SyncTokenResponse } from "@synch/sync-client/sync/remote/client";
import { InMemorySyncDiagnostics } from "@synch/sync-client/sync/diagnostics/in-memory";
import type { SyncFailurePhase } from "@synch/sync-client/sync/diagnostics/types";
import { SyncController } from "./sync-controller";
import { SyncTokenManager } from "@synch/sync-client/sync/remote/token-manager";
import { formatSyncStatusLabel } from "./status/sync-status-label";
import { isRemoteVaultUnavailableError } from "@synch/sync-client/remote-vault/unavailable";
import { RemoteVaultManager } from "@synch/sync-client/remote-vault/manager";

export interface SynchPluginControllerDeps {
  plugin: Plugin;
  refreshUi: () => void;
  emitUiEvent?: (event: SynchUiEvent) => void;
}

export class SynchPluginController implements SynchSettingsController {
  private readonly plugin = this.deps.plugin;
  private readonly diagnostics = new InMemorySyncDiagnostics(
    this.plugin.manifest.version,
  );
  private diagnosticsUnsubscribe: (() => void) | null = null;
  private readonly pluginDataStore = new SynchPluginDataStore(this.plugin);
  private readonly settingsStore = new SynchSettingsStore(this.pluginDataStore);
  private readonly sessionStore = new SynchPluginSessionStore({
    plugin: this.plugin,
    refreshUi: () => {
      this.refreshUi();
    },
  });
  private readonly updateService = new SynchPluginUpdateService({
    getApiBaseUrl: () => this.getApiBaseUrl(),
    getPluginVersion: () => this.plugin.manifest.version,
    refreshUi: () => {
      this.refreshUi();
    },
    onPluginUpdateRequired: () => {
      this.syncController.stopAutoSyncAndMarkNotReady();
    },
    notify: (message, timeout) => {
      new Notice(message, timeout);
    },
  });
  private readonly subscriptionService = new SynchSubscriptionService({
    getApiBaseUrl: () => this.getApiBaseUrl(),
    hasAuthenticatedSession: () => this.hasAuthenticatedSession(),
    getAuthSessionToken: () => this.authManager.getAuthSessionToken(),
    refreshUi: () => {
      this.refreshUi();
    },
  });
  private readonly authManager = new AuthManager({
    sessionTokenStore: new ObsidianAuthSessionTokenStore(this.plugin),
    getApiBaseUrl: () => this.getApiBaseUrl(),
    authClient: new AuthClient(defaultHttpClient, "synch-obsidian-plugin"),
    refreshUi: () => {
      this.refreshUi();
    },
    getLocale: () => getSynchLocale(),
    notify: (event) => {
      new Notice(
        formatAuthNotice(event, this.authManager.getAuthStatus()),
      );
    },
  });
  private readonly remoteVaultManager = new RemoteVaultManager({
    getApiBaseUrl: () => this.getApiBaseUrl(),
    getAuthSessionToken: () => this.authManager.getAuthSessionToken(),
    hasAuthenticatedSession: () => this.authManager.hasAuthenticatedSession(),
    getStoredRemoteVaultId: () => this.sessionStore.getStoredRemoteVaultId(),
    getStoredRemoteVaultKeySecret: () =>
      this.sessionStore.getStoredRemoteVaultKeySecret(),
    saveStoredRemoteVaultKeySecret: async (vault) => {
      await this.sessionStore.saveStoredRemoteVaultKeySecret(vault);
    },
    refreshUi: () => {
      this.refreshUi();
    },
    notify: (event) => {
      new Notice(formatRemoteVaultNotice(event));
    },
    remoteVaultClient: new RemoteVaultClient(defaultHttpClient),
  });
  private readonly syncTokenManager = new SyncTokenManager({
    getApiBaseUrl: () => this.getApiBaseUrl(),
    getAuthSessionToken: () => this.authManager.getAuthSessionToken(),
    getRemoteVaultId: () => this.remoteVaultManager.getRemoteVaultId(),
    getLocalVaultId: async () => await this.syncController.readLocalVaultId(),
    syncAccessClient: new SyncAccessClient(defaultHttpClient),
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
    getVaultConfigSyncRules: () => this.getVaultConfigSyncRules(),
    getSyncIntervalMs: () => this.getSyncIntervalMs(),
    hasActiveRemoteVaultSession: () => this.hasActiveRemoteVaultSession(),
    hasConnectedRemoteVault: () => this.hasConnectedRemoteVault(),
    hasAuthenticatedSession: () => this.hasAuthenticatedSession(),
    diagnostics: this.diagnostics,
    notifyError: (error, phase) => {
      this.notifyError(error, getErrorContextKeyForPhase(phase));
    },
    notify: (message, timeout) => {
      new Notice(message, timeout);
    },
    formatSyncConflictNotice: (event) => {
      if (event.reason === "remote_path_collision" && event.conflictPath) {
        return t("sync.pathCollision", { path: event.conflictPath });
      }

      if (event.op === "upsert" && event.conflictPath) {
        return t("sync.conflictLocalSaved", { path: event.conflictPath });
      }

      return t("sync.conflictRemoteKept", { path: event.originalPath });
    },
    formatRollbackDetectedNotice: (event) =>
      t("sync.rollbackDetected", { path: event.path ?? event.entryId }),
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
      new Notice(t("storage.quotaExceeded"));
    },
    onRemoteVaultUnavailable: async (error) => {
      await this.readinessCoordinator.disconnectUnavailableRemoteVault(error);
    },
  });
  private readonly readinessCoordinator = new SynchReadinessCoordinator({
    syncController: this.syncController,
    remoteVaultManager: this.remoteVaultManager,
    sessionStore: this.sessionStore,
    isPluginUpdateRequired: () => this.updateService.isPluginUpdateRequired(),
    refreshAuthReadiness: async () => await this.authManager.refreshReadiness(),
    isSyncEnabled: () => this.isSyncEnabled(),
    clearSyncTokenState: () => {
      this.clearSyncTokenState();
    },
    notifyError: (error, contextKey) => {
      this.notifyError(error, contextKey);
    },
    emitUiEvent: (event) => {
      this.emitUiEvent(event);
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
    getStoredRemoteVaultId: () => this.sessionStore.getStoredRemoteVaultId(),
    hasConnectedRemoteVault: () => this.hasConnectedRemoteVault(),
    initializeSyncStoreForActiveRemoteVault: async () => {
      await this.readinessCoordinator.initializeSyncStoreForActiveRemoteVault();
    },
    ensureAutoSyncState: async () => {
      await this.ensureAutoSyncState();
    },
    resetSyncConnection: async () => {
      await this.readinessCoordinator.resetSyncConnection();
    },
    notifyError: (error, contextKey) => {
      this.notifyError(error, contextKey);
    },
  });

  constructor(private readonly deps: SynchPluginControllerDeps) {
    this.diagnosticsUnsubscribe = this.diagnostics.subscribe(() => {
      this.emitUiEvent({ type: "sync-log-changed" });
    });
  }

  async initialize(): Promise<void> {
    await this.pluginDataStore.initialize();
    await this.initializeSettings();
    await this.updateService.checkServerCompatibility();
    await this.sessionStore.loadStoredRemoteVaultKeySecret();
    this.sessionStore.setStoredSyncConnection(
      await this.syncController.readStoredConnection(),
    );
    await this.authManager.initialize();
  }

  async stop(): Promise<void> {
    this.diagnosticsUnsubscribe?.();
    this.diagnosticsUnsubscribe = null;
    await this.syncController.stop();
  }

  queueQuitInFlightSyncWait(
    tasks: { addPromise: (promise: Promise<unknown>) => void },
    timeoutMs: number,
  ): void {
    this.syncController.queueQuitInFlightSyncWait(tasks, timeoutMs);
  }

  registerVaultEvents(): void {
    if (this.updateService.isPluginUpdateRequired()) {
      return;
    }

    this.syncController.registerVaultEvents();
  }

  ensureAutoSyncState(): Promise<void> {
    return this.readinessCoordinator.ensureAutoSyncState();
  }

  queueAutoSyncResume(): void {
    this.readinessCoordinator.queueAutoSyncResume();
  }

  getCommunityPluginUpdateStatus(): SynchCommunityPluginUpdateStatus {
    return this.updateService.getCommunityPluginUpdateStatus();
  }

  getServerCompatibilityStatus(): SynchServerCompatibilityStatus {
    return this.updateService.getServerCompatibilityStatus();
  }

  async ensureCommunityPluginUpdateCheck(): Promise<void> {
    await this.updateService.ensureCommunityPluginUpdateCheck();
  }

  async retryCommunityPluginUpdateCheck(): Promise<void> {
    await this.updateService.retryCommunityPluginUpdateCheck();
  }

  getSubscriptionStatus(): SynchSubscriptionStatus {
    return this.subscriptionService.getSubscriptionStatus();
  }

  async ensureSubscriptionStatusCheck(): Promise<void> {
    await this.subscriptionService.ensureSubscriptionStatusCheck();
  }

  async retrySubscriptionStatusCheck(): Promise<void> {
    await this.subscriptionService.retrySubscriptionStatusCheck();
  }

  openBillingManagementPage(): void {
    this.subscriptionService.openBillingManagementPage();
  }

  openPricingPage(): void {
    this.subscriptionService.openPricingPage();
  }

  getAuthStatusLabel(): string {
    return formatAuthStatusLabel(this.authManager.getAuthStatus());
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

  cancelDeviceLogin(): void {
    this.authManager.cancelDeviceLogin();
  }

  getRemoteVaultStatusLabel(): string {
    return formatRemoteVaultStatusLabel(
      this.remoteVaultManager.getRemoteVaultStatus(),
    );
  }

  hasConnectedRemoteVault(): boolean {
    return this.remoteVaultManager.hasConnectedRemoteVault();
  }

  getSyncStatusLabel(): string {
    if (this.updateService.isPluginUpdateRequired()) {
      return t("plugin.updateRequiredStatus");
    }

    return formatSyncStatusLabel(
      this.syncController.getSyncState(),
      this.syncController.getSyncProgress(),
    );
  }

  getSyncState(): SynchSyncState {
    if (this.updateService.isPluginUpdateRequired()) {
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

  getSyncLogs(): SynchSyncLogs {
    return this.diagnostics.getSnapshot();
  }

  clearSyncLogs(): void {
    this.diagnostics.clear();
  }

  subscribeSyncLogs(listener: () => void): () => void {
    return this.diagnostics.subscribe(listener);
  }

  isSyncEnabled(): boolean {
    return this.settingsStore.getSnapshot().syncEnabled;
  }

  async setSyncEnabled(enabled: boolean): Promise<void> {
    if (enabled && this.updateService.isPluginUpdateRequired()) {
      new Notice(this.updateService.getPluginUpdateRequiredMessage());
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

  getSyncIntervalMs(): number {
    return this.settingsStore.getSnapshot().syncIntervalMs;
  }

  async setSyncIntervalMs(value: number): Promise<void> {
    const changed = await this.settingsStore.updateSyncIntervalMs(value);
    if (!changed) {
      return;
    }

    this.refreshUi();
    if (this.isSyncEnabled()) {
      await this.ensureAutoSyncState();
    }
  }

  async syncNow(): Promise<void> {
    await this.readinessCoordinator.runWhenReady(() => this.syncController.syncNow());
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
    return normalizeSyncFileRules(
      this.settingsStore.getSnapshot().fileRules,
      this.configDir(),
    );
  }

  getVaultConfigSyncRules(): SynchVaultConfigSyncRules {
    return this.settingsStore.getSnapshot().vaultConfigSync;
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
      excludedFolders: paths,
    });
  }

  async updateIncludedHiddenFolders(paths: string[]): Promise<void> {
    await this.updateSyncFileRules({
      ...this.getSyncFileRules(),
      includedHiddenFolders: paths,
    });
  }

  async updateVaultConfigSyncRule<K extends keyof SynchVaultConfigSyncRules>(
    key: K,
    value: SynchVaultConfigSyncRules[K],
  ): Promise<void> {
    await this.updateVaultConfigSyncRules({
      ...this.getVaultConfigSyncRules(),
      [key]: value,
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
      this.updateService.clearCommunityPluginUpdateStatus();
      this.refreshUi();
    }
  }

  async getSyncTokenForActiveRemoteVault(): Promise<SyncTokenResponse> {
    let token: SyncTokenResponse;
    try {
      token = await this.syncTokenManager.getTokenForActiveRemoteVault();
    } catch (error) {
      if (isRemoteVaultUnavailableError(error)) {
        await this.readinessCoordinator.disconnectUnavailableRemoteVault(error);
      }
      throw error;
    }

    return token;
  }

  async beginDeviceLogin(): Promise<void> {
    let loginStarted = false;

    try {
      loginStarted = await this.authManager.beginDeviceLogin();
    } finally {
      if (loginStarted) {
        this.subscriptionService.clearSubscriptionStatus();
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
      this.subscriptionService.clearSubscriptionStatus();
      this.clearSyncTokenState();
      this.remoteVaultManager.clearSession();
      await this.sessionStore.saveStoredRemoteVaultKeySecret(null);
      await this.readinessCoordinator.resetSyncConnection();
    }
  }

  private clearSyncTokenState(): void {
    this.syncTokenManager.clear();
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
    return await this.versionHistoryController.restoreActiveFileVersion(versionId);
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

  private notifyError(error: unknown, contextKey: SynchErrorContextKey): void {
    new Notice(formatSynchErrorNotice(error, contextKey));
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
      this.notifyError(error, "error.pluginSettingsInitialization");
    }
  }

  private async updateSyncFileRules(nextRules: SyncFileRules): Promise<void> {
    const changed = await this.settingsStore.updateFileRules(
      nextRules,
      this.configDir(),
    );
    if (!changed) {
      return;
    }

    if (!this.isSyncEnabled()) {
      this.syncController.stopAutoSyncAndMarkPaused();
      return;
    }

    await this.syncController.reconcileAfterFileRuleChange();
  }

  private async updateVaultConfigSyncRules(
    nextRules: SynchVaultConfigSyncRules,
  ): Promise<void> {
    const changed = await this.settingsStore.updateVaultConfigSyncRules(nextRules);
    if (!changed) {
      return;
    }

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
      if (
        !normalized ||
        isReservedSyncPath(normalized, this.configDir())
      ) {
        continue;
      }

      if (normalized.split("/").some((segment) => segment.startsWith("."))) {
        result.push(normalized);
      }

      await this.collectSelectableHiddenFolders(normalized, result);
    }
  }

  private configDir(): string {
    return this.plugin.app.vault.configDir;
  }
}

function getErrorContextKeyForPhase(
  phase: SyncFailurePhase,
): SynchErrorContextKey {
  switch (phase) {
    case "store_initialization":
      return "error.localSyncStoreInitialization";
    case "auto_sync_initialization":
      return "error.autoSyncInitialization";
    case "auto_sync_resume":
      return "error.autoSyncResume";
    case "sync_event_handling":
      return "error.syncEventHandling";
    case "file_rule_update":
      return "error.syncFileRuleUpdate";
    case "local_state_reset":
      return "error.localSyncStateReset";
    case "hidden_folder_scan":
      return "error.hiddenFolderScan";
    case "auto_sync":
      return "error.autoSync";
  }
}
