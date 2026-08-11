import type { Plugin } from "obsidian";

import { getSynchLocale, type SynchErrorContextKey } from "../../i18n";
import {
  openBootstrapRemoteVaultModal,
  openConfirmConnectNonEmptyLocalVaultModal,
  openCreateRemoteVaultModal,
} from "./remote-vault-modals";
import type { RemoteVaultPort } from "./ports";
import { shouldSyncPath, type SyncFileRules } from "@synch/sync-client/sync/core/file-rules";

// Minimal port of SyncController required by the remote-vault flow.
export interface RemoteVaultSyncPort {
  detachLocalVaultFromServer(): Promise<void>;
}

export interface SynchRemoteVaultControllerDeps {
  plugin: Plugin;
  remoteVaultManager: RemoteVaultPort;
  syncController: RemoteVaultSyncPort;
  clearSyncTokenState: () => void;
  getApiBaseUrl: () => string;
  getSyncFileRules: () => SyncFileRules;
  getStoredRemoteVaultId: () => string | null;
  hasConnectedRemoteVault: () => boolean;
  initializeSyncStoreForActiveRemoteVault: () => Promise<void>;
  ensureAutoSyncState: () => Promise<void>;
  resetSyncConnection: () => Promise<void>;
  notifyError: (error: unknown, contextKey: SynchErrorContextKey) => void;
}

export class SynchRemoteVaultController {
  constructor(private readonly deps: SynchRemoteVaultControllerDeps) {}

  async createRemoteVaultFromPrompt(): Promise<void> {
    try {
      if (this.deps.hasConnectedRemoteVault()) {
        throw new Error("Disconnect the current vault before creating another one.");
      }

      const input = await openCreateRemoteVaultModal(this.deps.plugin.app, "");
      if (!input) {
        return;
      }

      await this.deps.remoteVaultManager.createRemoteVault(input);
      await this.deps.initializeSyncStoreForActiveRemoteVault();
      await this.deps.ensureAutoSyncState();
    } catch (error) {
      this.deps.notifyError(error, "error.vaultCreation");
    }
  }

  async connectRemoteVaultFromPrompt(): Promise<void> {
    try {
      if (this.deps.hasConnectedRemoteVault()) {
        throw new Error("Disconnect the current vault before connecting another one.");
      }

      if (this.hasSyncableLocalFiles()) {
        const confirmed = await openConfirmConnectNonEmptyLocalVaultModal(
          this.deps.plugin.app,
        );
        if (!confirmed) {
          return;
        }
      }

      const vaults = await this.deps.remoteVaultManager.listRemoteVaults();
      const input = await openBootstrapRemoteVaultModal(
        this.deps.plugin.app,
        vaults,
        this.deps.getStoredRemoteVaultId(),
        async (input) => {
          await this.deps.remoteVaultManager.bootstrapRemoteVault(input);
        },
      );
      if (!input) {
        return;
      }

      await this.deps.initializeSyncStoreForActiveRemoteVault();
      await this.deps.ensureAutoSyncState();
    } catch (error) {
      this.deps.notifyError(error, "error.vaultConnection");
    }
  }

  openRemoteVaultManagementPage(): void {
    const url = new URL("/vaults", this.deps.getApiBaseUrl());
    url.searchParams.set("lang", getSynchLocale());
    window.open(url.toString(), "_blank", "noopener,noreferrer");
  }

  async disconnectRemoteVault(): Promise<void> {
    try {
      try {
        await this.deps.syncController.detachLocalVaultFromServer();
      } catch {
        // Local disconnect should continue when the server cannot be reached.
      }
      await this.deps.remoteVaultManager.disconnectRemoteVault();
    } catch (error) {
      this.deps.notifyError(error, "error.vaultDisconnect");
    } finally {
      this.deps.clearSyncTokenState();
      await this.deps.resetSyncConnection();
    }
  }

  private hasSyncableLocalFiles(): boolean {
    const fileRules = this.deps.getSyncFileRules();
    const configDir = this.deps.plugin.app.vault.configDir;
    return this.deps.plugin.app.vault
      .getFiles()
      .some((file) => shouldSyncPath(file.path, fileRules, configDir));
  }
}
