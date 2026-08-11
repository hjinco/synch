import { Notice } from "obsidian";

import type { AuthReadiness } from "@synch/sync-client/auth/manager";
import { t, type SynchErrorContextKey } from "../i18n";
import { isOfflineLikeError } from "@synch/sync-client/http/network-status";
import type { RemoteVaultManager } from "@synch/sync-client/remote-vault/manager";
import {
  isRemoteVaultUnavailableError,
  type RemoteVaultUnavailableError,
} from "@synch/sync-client/remote-vault/unavailable";
import type { SyncController } from "./sync-controller";
import type { SynchUiEvent } from "../ui/ui-events";
import type { SynchPluginSessionStore } from "./session-store";

export interface SynchReadinessCoordinatorDeps {
  syncController: SyncController;
  remoteVaultManager: RemoteVaultManager;
  sessionStore: SynchPluginSessionStore;
  isPluginUpdateRequired: () => boolean;
  refreshAuthReadiness: () => Promise<AuthReadiness>;
  isSyncEnabled: () => boolean;
  clearSyncTokenState: () => void;
  notifyError: (error: unknown, contextKey: SynchErrorContextKey) => void;
  emitUiEvent: (event: SynchUiEvent) => void;
}

export class SynchReadinessCoordinator {
  private resumeAutoSyncPromise: Promise<void> | null = null;
  private remoteVaultUnavailableDisconnectPromise: Promise<void> | null = null;

  constructor(private readonly deps: SynchReadinessCoordinatorDeps) {}

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
        this.notifyUnlessOffline(error, "error.autoSyncResume");
      })
      .finally(() => {
        this.resumeAutoSyncPromise = null;
      });
  }

  async initializeSyncStoreForActiveRemoteVault(): Promise<void> {
    const remoteVaultId = this.deps.remoteVaultManager.getRemoteVaultId();
    if (!remoteVaultId) {
      return;
    }

    await this.deps.syncController.initializeStore(remoteVaultId);
    this.deps.sessionStore.setStoredSyncConnection(
      await this.deps.syncController.readStoredConnection(),
    );
    this.deps.emitUiEvent({ type: "file-size-blocked-changed" });
  }

  async resetSyncConnection(): Promise<void> {
    try {
      await this.deps.syncController.resetLocalSyncState();
      this.deps.sessionStore.setStoredSyncConnection(null);
    } catch (error) {
      void this.deps.syncController.recordSyncError(error, "local_state_reset");
      this.deps.notifyError(error, "error.localSyncStateReset");
      this.deps.syncController.stopAutoSyncAndMarkNotReady();
    }
  }

  notifyUnlessOffline(
    error: unknown,
    contextKey: SynchErrorContextKey,
  ): void {
    if (isRemoteVaultUnavailableError(error)) {
      void this.disconnectUnavailableRemoteVault(error);
      return;
    }

    if (isOfflineLikeError(error)) {
      this.deps.syncController.markOffline();
      return;
    }

    this.deps.syncController.markAttentionNeeded();
    this.deps.notifyError(error, contextKey);
  }

  async disconnectUnavailableRemoteVault(
    error: RemoteVaultUnavailableError,
  ): Promise<void> {
    if (this.remoteVaultUnavailableDisconnectPromise) {
      await this.remoteVaultUnavailableDisconnectPromise;
      return;
    }

    const activeRemoteVaultId = this.deps.remoteVaultManager.getRemoteVaultId();
    const storedRemoteVaultId = this.deps.sessionStore.getStoredRemoteVaultId();
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

  private async resumeAutoSyncWhenPossible(): Promise<void> {
    await this.runWhenReady(() => this.deps.syncController.resumeAutoSync());
  }

  private async reconcileReadiness(): Promise<void> {
    await this.runWhenReady(() =>
      this.deps.syncController.ensureAutoSyncState(),
    );
  }

  async runWhenReady(
    startAutoSync: () => Promise<void>,
  ): Promise<void> {
    if (this.deps.isPluginUpdateRequired()) {
      this.deps.syncController.stopAutoSyncAndMarkNotReady();
      return;
    }

    const authReadiness = await this.deps.refreshAuthReadiness();

    if (authReadiness.state === "pending_network") {
      this.deps.syncController.markOffline();
      return;
    }

    if (authReadiness.state !== "verified") {
      if (!this.deps.isSyncEnabled()) {
        this.deps.syncController.stopAutoSyncAndMarkPaused();
        return;
      }

      this.deps.syncController.stopAutoSyncAndMarkNotReady();
      return;
    }

    let hasActiveRemoteVaultStore = false;
    try {
      hasActiveRemoteVaultStore = await this.ensureActiveRemoteVaultStore();
    } catch (error) {
      this.notifyUnlessOffline(error, "error.vaultRestore");
      return;
    }

    if (!hasActiveRemoteVaultStore) {
      this.deps.syncController.stopAutoSyncAndMarkNotReady();
      return;
    }

    if (!this.deps.isSyncEnabled()) {
      this.deps.syncController.stopAutoSyncAndMarkPaused();
      return;
    }

    await startAutoSync();
  }

  private async ensureActiveRemoteVaultStore(): Promise<boolean> {
    if (!this.hasActiveRemoteVaultSession()) {
      try {
        await this.deps.remoteVaultManager.restoreStoredSessionIfNeeded();
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

    if (this.deps.syncController.hasStore()) {
      return true;
    }

    await this.initializeSyncStoreForActiveRemoteVault();
    return this.hasActiveRemoteVaultSession();
  }

  private hasActiveRemoteVaultSession(): boolean {
    return this.deps.remoteVaultManager.getActiveSession() !== null;
  }

  private async runUnavailableRemoteVaultDisconnect(
    error: RemoteVaultUnavailableError,
  ): Promise<void> {
    this.deps.syncController.stopAutoSyncAndMarkNotReady();
    this.deps.clearSyncTokenState();
    await this.deps.remoteVaultManager.disconnectRemoteVault({ notify: false });
    await this.resetSyncConnection();

    const message =
      error.reason === "not_found"
        ? t("vault.remoteRemoved")
        : t("vault.remoteAccessUnavailable");
    new Notice(message);
  }
}
