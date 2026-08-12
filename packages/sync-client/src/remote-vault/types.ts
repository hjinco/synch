import type { RemoteVaultKeyEnvelope } from "@synch/vault-crypto/types";

export type {
  RemoteVaultKeyDerivationMetadata,
  RemoteVaultKeyWrapMetadata,
  RemoteVaultKeyEnvelope,
} from "@synch/vault-crypto/types";

export interface RemoteVaultKeyWrapper {
  kind: "password" | "member" | "recovery";
  envelope: RemoteVaultKeyEnvelope;
}

export interface RemoteVaultRecord {
  id: string;
  organizationId: string;
  name: string;
  activeKeyVersion: number;
  createdAt: string;
}

export interface RemoteVaultKeyWrapperRecord {
  id: string;
  vaultId: string;
  keyVersion: number;
  kind: "password" | "member" | "recovery";
  userId: string | null;
  envelope: RemoteVaultKeyEnvelope;
  createdAt: string;
  revokedAt: string | null;
}

export interface RemoteVaultBootstrapResponse {
  vault: RemoteVaultRecord;
  wrappers: RemoteVaultKeyWrapperRecord[];
}

export interface RemoteVaultSummaryResponse {
  vaults: RemoteVaultRecord[];
}

export interface CreateRemoteVaultResponse {
  vault: RemoteVaultRecord;
}

export interface RemoteVaultSessionSummary {
  vaultId: string;
  vaultName: string;
  activeKeyVersion: number;
  bootstrappedAt: string | null;
}

export interface RemoteVaultSession {
  summary: RemoteVaultSessionSummary;
  remoteVaultKey: Uint8Array;
}

/** Host-persisted vault key bytes. Credential storage stays in the host. */
export interface StoredRemoteVaultKeySecret {
  remoteVaultKey: Uint8Array;
}
