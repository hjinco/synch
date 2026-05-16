import type { AuthReadiness } from "../auth/manager";
import type {
  SynchDeletedFileCursor,
  SynchDeletedFilesPage,
  SynchDeletedFilesPurgeResult,
  SynchDeletedFile,
  SynchDeletedFilesRestoreResult,
  SynchFileSizeBlockedFile,
  SynchFileRules,
  SynchVaultConfigSyncRules,
  SynchPluginUpdateStatus,
  SynchStorageStatus,
  SynchSubscriptionStatus,
  SynchSyncProgress,
  SynchSyncState,
  SynchVersionPreview,
} from "../plugin/view-models";

export interface SynchSettingsController {
  getPluginUpdateStatus(): SynchPluginUpdateStatus;
  ensurePluginUpdateCheck(): Promise<void>;
  retryPluginUpdateCheck(): Promise<void>;
  getSubscriptionStatus(): SynchSubscriptionStatus;
  ensureSubscriptionStatusCheck(): Promise<void>;
  retrySubscriptionStatusCheck(): Promise<void>;
  openBillingManagementPage(): void;
  openPricingPage(): void;
  getAuthReadiness(): AuthReadiness;
  getAuthStatusLabel(): string;
  getSyncState(): SynchSyncState;
  getSyncStatusLabel(): string;
  getSyncPercent(): number;
  getSyncProgress(): SynchSyncProgress;
  listFileSizeBlockedFiles(): Promise<SynchFileSizeBlockedFile[]>;
  isSyncEnabled(): boolean;
  setSyncEnabled(enabled: boolean): Promise<void>;
  getStorageStatus(): SynchStorageStatus | null;
  watchStorageStatus(): void;
  unwatchStorageStatus(): void;
  getRemoteVaultStatusLabel(): string;
  getRemoteVaultSyncFormatVersion(): number | null;
  getApiBaseUrl(): string;
  hasAuthenticatedSession(): boolean;
  isDeviceLoginInProgress(): boolean;
  hasConnectedRemoteVault(): boolean;
  beginDeviceLogin(): Promise<void>;
  signOutDevice(): Promise<void>;
  createRemoteVaultFromPrompt(): Promise<void>;
  connectRemoteVaultFromPrompt(): Promise<void>;
  openRemoteVaultManagementPage(): void;
  disconnectRemoteVault(): Promise<void>;
  updateApiBaseUrl(value: string): Promise<void>;
  getSyncFileRules(): SynchFileRules;
  getVaultConfigSyncRules(): SynchVaultConfigSyncRules;
  updateSyncFileRule<K extends keyof SynchFileRules>(
    key: K,
    value: SynchFileRules[K],
  ): Promise<void>;
  updateExcludedFolders(paths: string[]): Promise<void>;
  listSelectableExcludedFolderPaths(): string[];
  updateIncludedHiddenFolders(paths: string[]): Promise<void>;
  listSelectableIncludedHiddenFolderPaths(): Promise<string[]>;
  updateVaultConfigSyncRule<K extends keyof SynchVaultConfigSyncRules>(
    key: K,
    value: SynchVaultConfigSyncRules[K],
  ): Promise<void>;
  listDeletedFiles(
    before: SynchDeletedFileCursor | null,
    limit: number,
  ): Promise<SynchDeletedFilesPage>;
  previewDeletedFile(entryId: string, fallbackPath: string): Promise<SynchVersionPreview>;
  restoreDeletedFiles(files: SynchDeletedFile[]): Promise<SynchDeletedFilesRestoreResult>;
  purgeDeletedFiles(files: SynchDeletedFile[]): Promise<SynchDeletedFilesPurgeResult>;
}
