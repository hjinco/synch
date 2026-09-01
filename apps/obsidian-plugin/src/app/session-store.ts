import type { Plugin } from "obsidian";

import type { StoredRemoteVaultKeySecret } from "@synch/sync-client/remote-vault/types";
import {
  clearStoredRemoteVaultKeySecret,
  migrateLegacyRemoteVaultKeySecret,
  readStoredRemoteVaultKeySecret,
  writeStoredRemoteVaultKeySecret,
} from "../adapters/remote-vault-device-storage";
import { migrateLegacyAuthSessionToken } from "../adapters/auth-session-storage";
import type { SyncConnection } from "@synch/sync-client/sync/store/store";

export interface SynchPluginSessionStoreDeps {
  plugin: Plugin;
  refreshUi: () => void;
}

export class SynchPluginSessionStore {
  private storedRemoteVaultKeySecret: StoredRemoteVaultKeySecret | null = null;
  private storedSyncConnection: SyncConnection | null = null;

  constructor(private readonly deps: SynchPluginSessionStoreDeps) {}

  async migrateLegacySecrets(): Promise<void> {
    await migrateLegacyAuthSessionToken(this.deps.plugin);
    await migrateLegacyRemoteVaultKeySecret(this.deps.plugin);
  }

  async loadStoredRemoteVaultKeySecret(): Promise<void> {
    this.storedRemoteVaultKeySecret = await readStoredRemoteVaultKeySecret(this.deps.plugin);
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
}
