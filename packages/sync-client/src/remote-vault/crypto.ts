import type { RemoteVaultKeyEnvelope } from "./types";
import { createArgon2idMetadata, deriveWrapKey } from "./kdf";
import { decodeBase64, encodeBase64, randomBytes, toArrayBuffer } from "../utils/bytes";

const WRAP_ALGORITHM = "aes-256-gcm";
const ENVELOPE_VERSION = 1;
const KEY_VERSION = 1;
const VAULT_KEY_BYTES = 32;
const AES_GCM_NONCE_BYTES = 12;

export interface PasswordWrapperOptions {
  kdfOverrides?: Partial<{
    memoryKiB: number;
    iterations: number;
    parallelism: number;
  }>;
}

export interface CreatePasswordWrapperResult {
  envelope: RemoteVaultKeyEnvelope;
  remoteVaultKey: Uint8Array;
}

export async function createPasswordWrappedRemoteVaultKey(
  password: string,
  options: PasswordWrapperOptions = {},
): Promise<CreatePasswordWrapperResult> {
  const trimmedPassword = normalizePassword(password);
  const remoteVaultKey = randomBytes(VAULT_KEY_BYTES);
  const kdf = createArgon2idMetadata(options.kdfOverrides);
  const wrapKey = await deriveWrapKey(trimmedPassword, kdf);
  const nonce = randomBytes(AES_GCM_NONCE_BYTES);
  const ciphertext = await encryptRemoteVaultKey(wrapKey, remoteVaultKey, nonce);

  return {
    remoteVaultKey,
    envelope: {
      version: ENVELOPE_VERSION,
      keyVersion: KEY_VERSION,
      kdf,
      wrap: {
        algorithm: WRAP_ALGORITHM,
        nonce: encodeBase64(nonce),
        ciphertext: encodeBase64(ciphertext),
      },
    },
  };
}

export async function unwrapRemoteVaultKeyWithPassword(
  password: string,
  envelope: RemoteVaultKeyEnvelope,
): Promise<Uint8Array> {
  const trimmedPassword = normalizePassword(password);
  validateEnvelope(envelope);

  const salt = decodeBase64(envelope.kdf.salt);
  const nonce = decodeBase64(envelope.wrap.nonce);
  const ciphertext = decodeBase64(envelope.wrap.ciphertext);
  const wrapKey = await deriveWrapKey(trimmedPassword, {
    ...envelope.kdf,
    salt: encodeBase64(salt),
  });
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(nonce),
    },
    wrapKey,
    toArrayBuffer(ciphertext),
  );

  return new Uint8Array(plaintext);
}

async function encryptRemoteVaultKey(
  wrapKey: CryptoKey,
  remoteVaultKey: Uint8Array,
  nonce: Uint8Array,
): Promise<Uint8Array> {
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(nonce),
    },
    wrapKey,
    toArrayBuffer(remoteVaultKey),
  );

  return new Uint8Array(ciphertext);
}

function validateEnvelope(envelope: RemoteVaultKeyEnvelope): void {
  if (envelope.version !== ENVELOPE_VERSION) {
    throw new Error(`unsupported wrapper version: ${envelope.version}`);
  }

  if (envelope.wrap.algorithm !== WRAP_ALGORITHM) {
    throw new Error(`unsupported wrap algorithm: ${envelope.wrap.algorithm}`);
  }
}

function normalizePassword(password: string): string {
  if (!password) {
    throw new Error("Password is required.");
  }

  if (password !== password.trim()) {
    throw new Error("Password cannot start or end with spaces.");
  }

  return password;
}
