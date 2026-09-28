import type { Plugin } from "obsidian";

import { getSynchLocale, type SynchErrorContextKey } from "../../i18n";
import { openExternalUrl } from "../../adapters/external-browser";
import {
  openConfirmConnectNonEmptyLocalVaultModal,
  openCreateRemoteVaultModal,
} from "./remote-vault-modals";
import { hasExistingVaultFiles } from "../../adapters/local-vault-content";
import { ConnectVaultFlow, type VaultAccessContext } from "./connect-vault-flow";
import { openConnectVaultModal } from "./connect-vault-modal";
import type { RemoteVaultPort } from "./ports";
import { shouldSyncPath, type SyncFileRules } from "@synch/sync-client/core";

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
  createVaultAccessContext: () => Promise<VaultAccessContext>;
  hasConnectedRemoteVault: () => boolean;
  initializeSyncStoreForActiveRemoteVault: () => Promise<void>;
  ensureAutoSyncState: () => Promise<void>;
  resetSyncConnection: () => Promise<void>;
  notifyError: (error: unknown, contextKey: SynchErrorContextKey) => void;
}

export class SynchRemoteVaultController {
  private vaultSetupInProgress = false;

  constructor(private readonly deps: SynchRemoteVaultControllerDeps) {}

  async createRemoteVaultFromPrompt(): Promise<void> {
    if (this.vaultSetupInProgress) return;
    this.vaultSetupInProgress = true;
    try {
      if (this.deps.hasConnectedRemoteVault()) {
        throw new Error("Disconnect the current vault before creating another one.");
      }

      const organizations = await this.deps.remoteVaultManager.listCreatableOrganizations();
      const input = await openCreateRemoteVaultModal(this.deps.plugin.app, "", organizations);
      if (!input) {
        return;
      }

      await this.deps.remoteVaultManager.createRemoteVault(input);
      await this.deps.initializeSyncStoreForActiveRemoteVault();
      await this.deps.ensureAutoSyncState();
    } catch (error) {
      this.deps.notifyError(error, "error.vaultCreation");
    } finally {
      this.vaultSetupInProgress = false;
    }
  }

  async connectRemoteVaultFromPrompt(): Promise<void> {
    if (this.vaultSetupInProgress) return;
    this.vaultSetupInProgress = true;
    try {
      if (this.deps.hasConnectedRemoteVault()) {
        throw new Error("Disconnect the current vault before connecting another one.");
      }

      const context = await this.deps.createVaultAccessContext();
      const connected = await openConnectVaultModal(
        this.deps.plugin.app,
        new ConnectVaultFlow({
          ...context,
          listLegacyVaults: () => this.deps.remoteVaultManager.listRemoteVaults(),
          hasExistingFiles: () => hasExistingVaultFiles(this.deps.plugin.app),
          confirmPersonalVault: async () => !this.hasSyncableLocalFiles() ||
            await openConfirmConnectNonEmptyLocalVaultModal(this.deps.plugin.app),
          bootstrap: (input, beforeActivate) => this.deps.remoteVaultManager.bootstrapRemoteVault(input, async () => {
            if (this.deps.hasConnectedRemoteVault()) {
              throw new Error("Disconnect the current vault before connecting another one.");
            }
            await beforeActivate();
          }),
        }),
        this.deps.getStoredRemoteVaultId(),
      );
      if (!connected) return;

      await this.deps.initializeSyncStoreForActiveRemoteVault();
      await this.deps.ensureAutoSyncState();
    } catch (error) {
      this.deps.notifyError(error, "error.vaultConnection");
    } finally {
      this.vaultSetupInProgress = false;
    }
  }

  openRemoteVaultManagementPage(): void {
    const url = new URL("/vaults", this.deps.getApiBaseUrl());
    url.searchParams.set("lang", getSynchLocale());
    openExternalUrl(url.toString());
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
