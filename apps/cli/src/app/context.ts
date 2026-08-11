import { AuthClient } from "@synch/sync-client/auth/client";
import { AuthManager, type AuthReadiness } from "@synch/sync-client/auth/manager";
import { RemoteVaultClient } from "@synch/sync-client/remote-vault/client";
import { RemoteVaultManager } from "@synch/sync-client/remote-vault/manager";
import {
  DEFAULT_SYNC_FILE_RULES,
  type SyncFileRules,
} from "@synch/sync-client/sync/core/file-rules";
import {
  DEFAULT_VAULT_CONFIG_SYNC_RULES,
  type VaultConfigSyncRules,
} from "@synch/sync-client/sync/core/vault-config-rules";
import { InMemorySyncDiagnostics } from "@synch/sync-client/sync/diagnostics/in-memory";
import { SyncAccessClient } from "@synch/sync-client/sync/remote/client";
import { SyncTokenManager } from "@synch/sync-client/sync/remote/token-manager";
import { SyncEngine } from "@synch/sync-client/sync/runtime/sync-engine";
import type {
  UserVisibleSyncProgress,
  UserVisibleSyncState,
} from "@synch/sync-client/sync/runtime/user-visible-status";

import { CLI_CLIENT_ID, CLI_VERSION, DEFAULT_CONFIG_DIR_NAME } from "../config";
import { NodeFsChangeSource } from "../host/change-source";
import { defaultHttpClient } from "../host/http";
import { VaultLock } from "../host/lock";
import {
  cliCredentialsPath,
  vaultLockPath,
  vaultSyncStorePath,
} from "../host/paths";
import { CliCredentialsStore } from "../host/secrets";
import { SqliteSyncStore } from "../host/sqlite-store";
import { NodeSyncVaultAdapter } from "../host/vault-adapter";
import { NodeVaultConfigSource } from "../host/vault-config-source";
import {
  consoleLogger,
  formatAuthNotice,
  formatRemoteVaultNotice,
  formatSyncConflictNotice,
  type Logger,
} from "./notices";

export interface CliAppContextOptions {
  /** Resolved absolute path of the vault directory. */
  vaultPath: string;
  apiBaseUrl: string;
  logger?: Logger;
  credentialsPath?: string;
  configDir?: string;
}

export class CliAppContext {
  readonly logger: Logger;
  readonly credentials: CliCredentialsStore;
  readonly authManager: AuthManager;
  readonly remoteVaultManager: RemoteVaultManager;
  readonly syncTokenManager: SyncTokenManager;
  readonly diagnostics = new InMemorySyncDiagnostics(`cli/${CLI_VERSION}`);
  readonly vaultAdapter: NodeSyncVaultAdapter;
  readonly changeSource: NodeFsChangeSource;
  readonly engine: SyncEngine;

  syncStatus: UserVisibleSyncState = "not_ready";
  syncProgress: UserVisibleSyncProgress = { completedEntries: 0, totalEntries: 0 };
  onSyncStatusChange: (() => void) | null = null;
  onReconcileRequested: (() => void) | null = null;

  private store: SqliteSyncStore | null = null;
  private lock: VaultLock | null = null;
  private lastSyncError: unknown = null;

  constructor(private readonly options: CliAppContextOptions) {
    this.logger = options.logger ?? consoleLogger;
    this.credentials = new CliCredentialsStore(
      options.credentialsPath ?? cliCredentialsPath(),
    );

    this.authManager = new AuthManager({
      sessionTokenStore: this.credentials.createSessionTokenStore(),
      getApiBaseUrl: () => this.options.apiBaseUrl,
      authClient: new AuthClient(defaultHttpClient, CLI_CLIENT_ID),
      refreshUi: () => {},
      getLocale: () => "en",
      notify: (event) => {
        this.logger.log(formatAuthNotice(event));
      },
      openExternalUrl: (url) => {
        this.logger.log(`Open this URL to sign in:\n  ${url}`);
      },
      isOffline: () => false,
    });

    this.remoteVaultManager = new RemoteVaultManager({
      getApiBaseUrl: () => this.options.apiBaseUrl,
      getAuthSessionToken: () => this.authManager.getAuthSessionToken(),
      hasAuthenticatedSession: () => this.authManager.hasAuthenticatedSession(),
      getStoredRemoteVaultId: () =>
        this.credentials.getVaultCredential(this.options.vaultPath)
          ?.remoteVaultId ?? null,
      getStoredRemoteVaultKeySecret: () =>
        this.credentials.getVaultCredential(this.options.vaultPath)?.secret ??
        null,
      saveStoredRemoteVaultKeySecret: async (secret) => {
        if (!secret) {
          await this.credentials.clearVaultCredential(this.options.vaultPath);
          return;
        }

        // The manager sets its active session before persisting the secret,
        // so the connected vault ID is available here.
        const remoteVaultId = this.remoteVaultManager.getRemoteVaultId();
        if (!remoteVaultId) {
          throw new Error("No active remote vault session to persist.");
        }
        await this.credentials.saveVaultCredential(
          this.options.vaultPath,
          remoteVaultId,
          secret,
        );
      },
      refreshUi: () => {},
      notify: (event) => {
        this.logger.log(formatRemoteVaultNotice(event));
      },
      remoteVaultClient: new RemoteVaultClient(defaultHttpClient),
    });

    this.syncTokenManager = new SyncTokenManager({
      getApiBaseUrl: () => this.options.apiBaseUrl,
      getAuthSessionToken: () => this.authManager.getAuthSessionToken(),
      getRemoteVaultId: () => this.remoteVaultManager.getRemoteVaultId(),
      getLocalVaultId: async () => await this.engine.readLocalVaultId(),
      syncAccessClient: new SyncAccessClient(defaultHttpClient),
    });

    const getConfigDir = () => this.options.configDir ?? DEFAULT_CONFIG_DIR_NAME;
    this.vaultAdapter = new NodeSyncVaultAdapter({
      vaultPath: this.options.vaultPath,
      getConfigDir,
      getSyncFileRules: () => this.getSyncFileRules(),
    });
    const vaultConfigSource = new NodeVaultConfigSource({
      vaultPath: this.options.vaultPath,
      getConfigDir,
      getVaultConfigSyncRules: () => this.getVaultConfigSyncRules(),
    });
    this.changeSource = new NodeFsChangeSource({
      vaultPath: this.options.vaultPath,
      vaultAdapter: this.vaultAdapter,
      isSyncableConfigPath: (path) => vaultConfigSource.isSyncablePath(path),
      requestReconcile: () => {
        this.onReconcileRequested?.();
      },
    });

    this.engine = new SyncEngine({
      vaultAdapter: this.vaultAdapter,
      vaultConfigSource,
      httpClient: defaultHttpClient,
      changeSource: this.changeSource,
      getConfigDir,
      createWebSocket: (url, protocols) => new WebSocket(url, protocols),
      getApiBaseUrl: () => this.options.apiBaseUrl,
      getSyncToken: async () =>
        await this.syncTokenManager.getTokenForActiveRemoteVault(),
      invalidateSyncToken: () => {
        this.syncTokenManager.clear();
      },
      getRemoteVaultKey: () => this.getActiveRemoteVaultKey(),
      getSyncFileRules: () => this.getSyncFileRules(),
      getVaultConfigSyncRules: () => this.getVaultConfigSyncRules(),
      shouldDeferSyncWork: () => false,
      hasActiveRemoteVaultSession: () =>
        this.remoteVaultManager.getActiveSession() !== null,
      diagnostics: this.diagnostics,
      onSyncError: (error, phase) => {
        this.lastSyncError = error;
        this.logger.error(`sync failed (${phase}): ${describeError(error)}`);
      },
      notifySyncConflict: (event) => {
        this.logger.log(formatSyncConflictNotice(event));
      },
      notifyRollbackDetected: (event) => {
        this.logger.log(
          `Rollback rejected for ${event.path ?? event.entryId} (local r${event.localRevision}, remote r${event.remoteRevision}).`,
        );
      },
      setSyncProgress: (progress) => {
        if (progress) {
          this.syncProgress = progress;
          this.onSyncStatusChange?.();
        }
      },
      setSyncStatus: (status) => {
        if (this.syncStatus !== status) {
          this.syncStatus = status;
          this.onSyncStatusChange?.();
        }
      },
      setStorageStatus: () => {},
      isOffline: () => false,
    });
  }

  get vaultPath(): string {
    return this.options.vaultPath;
  }

  get apiBaseUrl(): string {
    return this.options.apiBaseUrl;
  }

  getSyncFileRules(): SyncFileRules {
    return DEFAULT_SYNC_FILE_RULES;
  }

  getActiveRemoteVaultKey(): Uint8Array {
    const session = this.remoteVaultManager.getActiveSession();
    if (!session) {
      throw new Error("Vault session is not loaded.");
    }

    return session.remoteVaultKey;
  }

  getVaultConfigSyncRules(): VaultConfigSyncRules {
    return DEFAULT_VAULT_CONFIG_SYNC_RULES;
  }

  takeLastSyncError(): unknown {
    const error = this.lastSyncError;
    this.lastSyncError = null;
    return error;
  }

  async initializeAuth(): Promise<AuthReadiness> {
    await this.authManager.initialize();
    return this.authManager.getReadiness();
  }

  requireVerifiedAuth(): void {
    const readiness = this.authManager.getReadiness();
    if (readiness.state === "verified") {
      return;
    }

    if (readiness.state === "anonymous") {
      throw new CliUsageError("Not signed in. Run `synch login` first.");
    }
    if (readiness.state === "pending_network") {
      throw new CliUsageError(
        "Could not verify the stored session (network unreachable). Try again when online.",
      );
    }
    throw new CliUsageError(
      "The stored session was rejected. Run `synch login` again.",
    );
  }

  hasStoredVaultCredential(): boolean {
    return this.credentials.getVaultCredential(this.options.vaultPath) !== null;
  }

  /**
   * Restores the remote vault session from stored credentials, acquires the
   * per-vault lock, and opens the local sync store.
   */
  async openVaultSession(): Promise<void> {
    if (!this.remoteVaultManager.getActiveSession()) {
      if (!this.hasStoredVaultCredential()) {
        throw new CliUsageError(
          "This vault is not connected. Run `synch vault connect --vault-id <id>` first.",
        );
      }
      await this.remoteVaultManager.restoreStoredSessionIfNeeded();
    }

    const remoteVaultId = this.remoteVaultManager.getRemoteVaultId();
    if (!remoteVaultId) {
      throw new CliUsageError(
        "Unable to load the remote vault session. Run `synch vault connect` again.",
      );
    }

    this.lock ??= await VaultLock.acquire(vaultLockPath(this.options.vaultPath));
    if (!this.store) {
      this.store = SqliteSyncStore.open(vaultSyncStorePath(this.options.vaultPath));
      this.engine.setStore(this.store);
    }
    await this.engine.getOrCreateLocalVaultId(remoteVaultId);
  }

  async close(): Promise<void> {
    this.changeSource.stop();
    this.engine.stopAutoSync();
    if (this.engine.hasStore()) {
      await this.engine.closeStore();
    } else {
      await this.store?.close();
    }
    this.store = null;
    await this.lock?.release();
    this.lock = null;
  }
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
