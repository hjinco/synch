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

export interface RemoteVaultKeyEnvelope {
  version: number;
  keyVersion: number;
  kdf: RemoteVaultKeyDerivationMetadata;
  wrap: RemoteVaultKeyWrapMetadata;
}
