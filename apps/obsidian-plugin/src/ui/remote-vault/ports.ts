import type {
  RemoteVaultRecord,
  RemoteVaultSessionSummary,
} from "@synch/sync-client/remote";

// Must stay structurally identical to CreateRemoteVaultInput /
// BootstrapRemoteVaultInput in @synch/sync-client/remote-vault/manager (the
// facade injects RemoteVaultManager as-is).
export interface CreateRemoteVaultInput {
  name: string;
  password: string;
  confirmPassword: string;
}

export interface BootstrapRemoteVaultInput {
  vaultId: string;
  password: string;
}

// Minimal port of RemoteVaultManager required by the remote-vault UI flow.
export interface RemoteVaultPort {
  createRemoteVault(
    input: CreateRemoteVaultInput,
  ): Promise<RemoteVaultSessionSummary>;
  listRemoteVaults(): Promise<RemoteVaultRecord[]>;
  bootstrapRemoteVault(
    input: BootstrapRemoteVaultInput,
  ): Promise<RemoteVaultSessionSummary>;
  disconnectRemoteVault(options?: { notify?: boolean }): Promise<void>;
}
