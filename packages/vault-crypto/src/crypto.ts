import type { RemoteVaultKeyEnvelope, VaultKeyBinding } from "./types";
import { createArgon2idMetadata, deriveWrapKey } from "./kdf";
import { decodeBase64, encodeBase64, randomBytes, toArrayBuffer } from "./bytes";

const WRAP_ALGORITHM = "aes-256-gcm";
const ENVELOPE_VERSION = 1;
const KEY_VERSION = 1;
const VAULT_KEY_BYTES = 32;
const AES_GCM_NONCE_BYTES = 12;

export class VaultPasswordError extends Error {
  constructor(
    readonly code: "required" | "outer_spaces",
    message: string,
  ) {
    super(message);
    this.name = "VaultPasswordError";
  }
}

export interface PasswordWrapperOptions {
  binding?: VaultKeyBinding;
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
  const remoteVaultKey = randomBytes(VAULT_KEY_BYTES);
  return { remoteVaultKey, envelope: await wrapRemoteVaultKeyWithPassword(password, remoteVaultKey, options) };
}

/** Rewrap an existing data key; a password change must never generate a new one. */
export async function wrapRemoteVaultKeyWithPassword(
  password: string,
  remoteVaultKey: Uint8Array,
  options: PasswordWrapperOptions = {},
): Promise<RemoteVaultKeyEnvelope> {
  if (remoteVaultKey.byteLength !== VAULT_KEY_BYTES) throw new Error("Invalid vault key length");
  const kdf = createArgon2idMetadata(options.kdfOverrides);
  const wrapKey = await deriveWrapKey(normalizePassword(password), kdf);
  const nonce = randomBytes(AES_GCM_NONCE_BYTES);
  const ciphertext = await encryptRemoteVaultKey(wrapKey, remoteVaultKey, nonce, options.binding);
  return {
    version: options.binding ? 2 : ENVELOPE_VERSION,
    keyVersion: KEY_VERSION,
    ...(options.binding ? { binding: options.binding } : {}),
    kdf,
    wrap: { algorithm: WRAP_ALGORITHM, nonce: encodeBase64(nonce), ciphertext: encodeBase64(ciphertext) },
  };
}

export async function unwrapRemoteVaultKeyWithPassword(
  password: string,
  envelope: RemoteVaultKeyEnvelope,
  expectedBinding?: VaultKeyBinding,
): Promise<Uint8Array> {
  const trimmedPassword = normalizePassword(password);
  validateEnvelope(envelope);
  if (envelope.version === 2 && (!expectedBinding || !envelope.binding ||
      envelope.binding.vaultId !== expectedBinding.vaultId || envelope.binding.userId !== expectedBinding.userId)) {
    throw new Error("Vault password wrapper belongs to a different vault or user");
  }

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
      ...(envelope.version === 2 ? { additionalData: bindingAad(envelope.binding!) } : {}),
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
  binding?: VaultKeyBinding,
): Promise<Uint8Array> {
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(nonce),
      ...(binding ? { additionalData: bindingAad(binding) } : {}),
    },
    wrapKey,
    toArrayBuffer(remoteVaultKey),
  );

  return new Uint8Array(ciphertext);
}

function validateEnvelope(envelope: RemoteVaultKeyEnvelope): void {
  if (envelope.version !== ENVELOPE_VERSION && envelope.version !== 2) {
    throw new Error(`unsupported wrapper version: ${envelope.version}`);
  }

  if (envelope.keyVersion !== KEY_VERSION || (envelope.version === 1 && envelope.binding) || (envelope.version === 2 && (!envelope.binding?.userId || !envelope.binding.vaultId))) throw new Error("Invalid password wrapper binding or key version");
  if (envelope.wrap.algorithm !== WRAP_ALGORITHM) {
    throw new Error(`unsupported wrap algorithm: ${envelope.wrap.algorithm}`);
  }
}

function normalizePassword(password: string): string {
  if (!password) {
    throw new VaultPasswordError("required", "Password is required.");
  }

  if (password !== password.trim()) {
    throw new VaultPasswordError(
      "outer_spaces",
      "Password cannot start or end with spaces.",
    );
  }

  return password;
}

function bindingAad(binding: VaultKeyBinding): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(JSON.stringify(["synch.password-wrapper", 2, binding.vaultId, binding.userId, KEY_VERSION])));
}
