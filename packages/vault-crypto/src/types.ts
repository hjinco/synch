export interface RemoteVaultKeyDerivationMetadata {
  name: string;
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  salt: string;
}

export interface RemoteVaultKeyWrapMetadata {
  algorithm: string;
  nonce: string;
  ciphertext: string;
}

export interface VaultKeyBinding {
  vaultId: string;
  userId: string;
}

export interface RemoteVaultKeyEnvelope {
  binding?: VaultKeyBinding;
  version: number;
  keyVersion: number;
  kdf: RemoteVaultKeyDerivationMetadata;
  wrap: RemoteVaultKeyWrapMetadata;
}
