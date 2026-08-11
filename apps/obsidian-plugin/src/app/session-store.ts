import type { Plugin } from "obsidian";

import type { StoredRemoteVaultKeySecret } from "@synch/sync-client/remote-vault/types";
import {
  clearStoredRemoteVaultKeySecret,
  readStoredRemoteVaultKeySecret,
  writeStoredRemoteVaultKeySecret,
} from "../adapters/remote-vault-device-storage";
import type { SyncConnection } from "@synch/sync-client/sync/store/store";

export interface SynchPluginSessionStoreDeps {
  plugin: Plugin;
  refreshUi: () => void;
}

export class SynchPluginSessionStore {
  private storedRemoteVaultKeySecret: StoredRemoteVaultKeySecret | null = null;
  private storedSyncConnection: SyncConnection | null = null;
  private remoteVaultSyncFormatVersion: number | null = null;

  constructor(private readonly deps: SynchPluginSessionStoreDeps) {}

  async loadStoredRemoteVaultKeySecret(): Promise<void> {
    this.storedRemoteVaultKeySecret = await readStoredRemoteVaultKeySecret(
      this.deps.plugin,
    );
  }

  getStoredRemoteVaultKeySecret(): StoredRemoteVaultKeySecret | null {
    return this.storedRemoteVaultKeySecret;
  }

  async saveStoredRemoteVaultKeySecret(
    vault: StoredRemoteVaultKeySecret | null,
  ): Promise<void> {
    this.storedRemoteVaultKeySecret = vault;
    if (vault) {
      await writeStoredRemoteVaultKeySecret(this.deps.plugin, vault);
    } else {
      await clearStoredRemoteVaultKeySecret(this.deps.plugin);
    }
    this.deps.refreshUi();
  }

  getStoredSyncConnection(): SyncConnection | null {
    return this.storedSyncConnection;
  }

  setStoredSyncConnection(connection: SyncConnection | null): void {
    this.storedSyncConnection = connection;
  }

  getStoredRemoteVaultId(): string | null {
    return this.storedSyncConnection?.remoteVaultId ?? null;
  }

  getRemoteVaultSyncFormatVersion(): number | null {
    return this.remoteVaultSyncFormatVersion;
  }

  setRemoteVaultSyncFormatVersion(version: number): void {
    if (this.remoteVaultSyncFormatVersion === version) {
      return;
    }

    this.remoteVaultSyncFormatVersion = version;
    this.deps.refreshUi();
  }

  clearRemoteVaultSyncFormatVersion(): void {
    this.remoteVaultSyncFormatVersion = null;
  }
}
