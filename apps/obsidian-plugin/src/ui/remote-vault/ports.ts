import type {
  CreateRemoteVaultInput,
  BootstrapRemoteVaultInput,
  RemoteVaultRecord,
  RemoteVaultSessionSummary,
} from "@synch/sync-client/remote";

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
