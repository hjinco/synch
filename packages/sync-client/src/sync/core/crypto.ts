import type { SyncedEntryMetadata } from "./content";
import { parseSyncedEntryMetadata, serializeSyncedEntryMetadata } from "./content";
import { decodeBase64, encodeBase64, randomBytes, toArrayBuffer } from "../../utils/bytes";

const ENVELOPE_VERSION = 1;
const SYNC_BLOB_BINARY_ENVELOPE_VERSION = 2;
const AES_GCM_NONCE_BYTES = 12;
const KEY_USAGE_SALT = new Uint8Array();
const SYNC_BLOB_V2_MAGIC = new Uint8Array([0x53, 0x59, 0x4e, 0x42]);
const SYNC_BLOB_V2_VERSION_OFFSET = SYNC_BLOB_V2_MAGIC.byteLength;
const SYNC_BLOB_V2_NONCE_OFFSET = SYNC_BLOB_V2_VERSION_OFFSET + 1;
const SYNC_BLOB_V2_CIPHERTEXT_OFFSET = SYNC_BLOB_V2_NONCE_OFFSET + AES_GCM_NONCE_BYTES;

export type SyncMetadataCryptoContext = {
  entryId: string;
  revision: number;
  op: "upsert" | "delete";
  blobId: string | null;
};

export type SyncBlobCryptoContext = {
  blobId: string;
};

export type SyncBlobEnvelopeOptions = {
  syncFormatVersion: number;
};

export interface SyncCryptoContext {
  encryptMetadata(
    metadata: SyncedEntryMetadata,
    context: SyncMetadataCryptoContext,
  ): Promise<string>;
  decryptMetadata(
    encryptedMetadata: string,
    context: SyncMetadataCryptoContext,
  ): Promise<SyncedEntryMetadata>;
  encryptBlob(
    plaintext: Uint8Array,
    context: SyncBlobCryptoContext,
    options: SyncBlobEnvelopeOptions,
  ): Promise<Uint8Array>;
  decryptBlob(
    encryptedBlob: Uint8Array,
    context: SyncBlobCryptoContext,
    options: SyncBlobEnvelopeOptions,
  ): Promise<Uint8Array>;
  dispose(): void;
}

type EncryptedEnvelope = {
  version: number;
  nonce: string;
  ciphertext: string;
};

export function createSyncCryptoContext(remoteVaultKey: Uint8Array): SyncCryptoContext {
  return new VaultSyncCryptoContext(remoteVaultKey);
}

export async function encryptSyncMetadata(
  remoteVaultKey: Uint8Array,
  metadata: SyncedEntryMetadata,
  context: SyncMetadataCryptoContext,
): Promise<string> {
  return await createSyncCryptoContext(remoteVaultKey).encryptMetadata(metadata, context);
}

export async function decryptSyncMetadata(
  remoteVaultKey: Uint8Array,
  encryptedMetadata: string,
  context: SyncMetadataCryptoContext,
): Promise<SyncedEntryMetadata> {
  return await createSyncCryptoContext(remoteVaultKey).decryptMetadata(
    encryptedMetadata,
    context,
  );
}

export async function encryptSyncBlob(
  remoteVaultKey: Uint8Array,
  plaintext: Uint8Array,
  context: SyncBlobCryptoContext,
  options: SyncBlobEnvelopeOptions,
): Promise<Uint8Array> {
  return await createSyncCryptoContext(remoteVaultKey).encryptBlob(
    plaintext,
    context,
    options,
  );
}

export async function decryptSyncBlob(
  remoteVaultKey: Uint8Array,
  encryptedBlob: Uint8Array,
  context: SyncBlobCryptoContext,
  options: SyncBlobEnvelopeOptions,
): Promise<Uint8Array> {
  return await createSyncCryptoContext(remoteVaultKey).decryptBlob(
    encryptedBlob,
    context,
    options,
  );
}

class VaultSyncCryptoContext implements SyncCryptoContext {
  private importedKey: CryptoKey | null = null;
  private readonly usageKeys = new Map<string, CryptoKey>();
  private disposed = false;

  constructor(private readonly remoteVaultKey: Uint8Array) {}

  async encryptMetadata(
    metadata: SyncedEntryMetadata,
    context: SyncMetadataCryptoContext,
  ): Promise<string> {
    const key = await this.getUsageKey("sync-metadata", ENVELOPE_VERSION);
    return await encryptEnvelope(
      key,
      new TextEncoder().encode(serializeSyncedEntryMetadata(metadata)),
      encodeMetadataAad(context),
      ENVELOPE_VERSION,
    );
  }

  async decryptMetadata(
    encryptedMetadata: string,
    context: SyncMetadataCryptoContext,
  ): Promise<SyncedEntryMetadata> {
    const key = await this.getUsageKey("sync-metadata", ENVELOPE_VERSION);
    const plaintext = await decryptEnvelope(
      key,
      encryptedMetadata,
      encodeMetadataAad(context),
      ENVELOPE_VERSION,
    );
    return parseSyncedEntryMetadata(new TextDecoder().decode(plaintext));
  }

  async encryptBlob(
    plaintext: Uint8Array,
    context: SyncBlobCryptoContext,
    options: SyncBlobEnvelopeOptions,
  ): Promise<Uint8Array> {
    switch (options.syncFormatVersion) {
      case ENVELOPE_VERSION: {
        const key = await this.getUsageKey("sync-blob", ENVELOPE_VERSION);
        const envelope = await encryptEnvelope(
          key,
          plaintext,
          encodeBlobAad(context, ENVELOPE_VERSION),
          ENVELOPE_VERSION,
        );
        return new TextEncoder().encode(envelope);
      }
      case SYNC_BLOB_BINARY_ENVELOPE_VERSION:
        return await this.encryptBinaryBlobEnvelope(plaintext, context);
      default:
        throwUnsupportedSyncBlobFormatVersion(options.syncFormatVersion);
    }
  }

  async decryptBlob(
    encryptedBlob: Uint8Array,
    context: SyncBlobCryptoContext,
    options: SyncBlobEnvelopeOptions,
  ): Promise<Uint8Array> {
    switch (options.syncFormatVersion) {
      case ENVELOPE_VERSION:
        return await decryptEnvelope(
          await this.getUsageKey("sync-blob", ENVELOPE_VERSION),
          new TextDecoder().decode(encryptedBlob),
          encodeBlobAad(context, ENVELOPE_VERSION),
          ENVELOPE_VERSION,
        );
      case SYNC_BLOB_BINARY_ENVELOPE_VERSION:
        return await this.decryptBinaryBlobEnvelope(encryptedBlob, context);
      default:
        throwUnsupportedSyncBlobFormatVersion(options.syncFormatVersion);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.importedKey = null;
    this.usageKeys.clear();
  }

  private async encryptBinaryBlobEnvelope(
    plaintext: Uint8Array,
    context: SyncBlobCryptoContext,
  ): Promise<Uint8Array> {
    const nonce = randomBytes(AES_GCM_NONCE_BYTES);
    const ciphertext = await encryptAesGcm(
      await this.getUsageKey("sync-blob", SYNC_BLOB_BINARY_ENVELOPE_VERSION),
      plaintext,
      nonce,
      encodeBlobAad(context, SYNC_BLOB_BINARY_ENVELOPE_VERSION),
    );
    const envelope = new Uint8Array(SYNC_BLOB_V2_CIPHERTEXT_OFFSET + ciphertext.byteLength);
    envelope.set(SYNC_BLOB_V2_MAGIC, 0);
    envelope[SYNC_BLOB_V2_VERSION_OFFSET] = SYNC_BLOB_BINARY_ENVELOPE_VERSION;
    envelope.set(nonce, SYNC_BLOB_V2_NONCE_OFFSET);
    envelope.set(ciphertext, SYNC_BLOB_V2_CIPHERTEXT_OFFSET);
    return envelope;
  }

  private async decryptBinaryBlobEnvelope(
    encryptedBlob: Uint8Array,
    context: SyncBlobCryptoContext,
  ): Promise<Uint8Array> {
    const { nonce, ciphertext } = parseBinaryBlobEnvelope(encryptedBlob);
    return await decryptAesGcm(
      await this.getUsageKey("sync-blob", SYNC_BLOB_BINARY_ENVELOPE_VERSION),
      ciphertext,
      nonce,
      encodeBlobAad(context, SYNC_BLOB_BINARY_ENVELOPE_VERSION),
    );
  }

  private async getUsageKey(usage: string, envelopeVersion: number): Promise<CryptoKey> {
    this.assertActive();
    const cacheKey = `${usage}:v${envelopeVersion}`;
    const cached = this.usageKeys.get(cacheKey);
    if (cached) {
      return cached;
    }

    const key = await deriveUsageKey(
      await this.getImportedKey(),
      usage,
      envelopeVersion,
    );
    this.usageKeys.set(cacheKey, key);
    return key;
  }

  private async getImportedKey(): Promise<CryptoKey> {
    this.assertActive();
    if (!this.importedKey) {
      this.importedKey = await crypto.subtle.importKey(
        "raw",
        toArrayBuffer(this.remoteVaultKey),
        "HKDF",
        false,
        ["deriveKey"],
      );
    }
    return this.importedKey;
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error("Sync crypto context has been disposed.");
    }
  }
}

async function encryptEnvelope(
  key: CryptoKey,
  plaintext: Uint8Array,
  additionalData: Uint8Array,
  envelopeVersion = ENVELOPE_VERSION,
): Promise<string> {
  const nonce = randomBytes(AES_GCM_NONCE_BYTES);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(nonce),
      additionalData: toArrayBuffer(additionalData),
    },
    key,
    toArrayBuffer(plaintext),
  );

  return JSON.stringify({
    version: envelopeVersion,
    nonce: encodeBase64(nonce),
    ciphertext: encodeBase64(new Uint8Array(ciphertext)),
  } satisfies EncryptedEnvelope);
}

async function decryptEnvelope(
  key: CryptoKey,
  serializedEnvelope: string,
  additionalData: Uint8Array,
  envelopeVersion = ENVELOPE_VERSION,
): Promise<Uint8Array> {
  const envelope = parseEncryptedEnvelope(serializedEnvelope, envelopeVersion);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(decodeBase64(envelope.nonce)),
      additionalData: toArrayBuffer(additionalData),
    },
    key,
    toArrayBuffer(decodeBase64(envelope.ciphertext)),
  );

  return new Uint8Array(plaintext);
}

async function encryptAesGcm(
  key: CryptoKey,
  plaintext: Uint8Array,
  nonce: Uint8Array,
  additionalData: Uint8Array,
): Promise<Uint8Array> {
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(nonce),
      additionalData: toArrayBuffer(additionalData),
    },
    key,
    toArrayBuffer(plaintext),
  );
  return new Uint8Array(ciphertext);
}

async function decryptAesGcm(
  key: CryptoKey,
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  additionalData: Uint8Array,
): Promise<Uint8Array> {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(nonce),
      additionalData: toArrayBuffer(additionalData),
    },
    key,
    toArrayBuffer(ciphertext),
  );
  return new Uint8Array(plaintext);
}

async function deriveUsageKey(
  importedKey: CryptoKey,
  usage: string,
  envelopeVersion: number,
): Promise<CryptoKey> {
  return await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toArrayBuffer(KEY_USAGE_SALT),
      info: new TextEncoder().encode(`${usage}:v${envelopeVersion}`),
    },
    importedKey,
    {
      name: "AES-GCM",
      length: 256,
    },
    false,
    ["encrypt", "decrypt"],
  );
}

function encodeMetadataAad(context: SyncMetadataCryptoContext): Uint8Array {
  return new TextEncoder().encode(
    [
      "synch.sync-metadata",
      `v${ENVELOPE_VERSION}`,
      context.entryId,
      String(context.revision),
      context.op,
      context.blobId ?? "",
    ].join("\n"),
  );
}

function encodeBlobAad(context: SyncBlobCryptoContext, envelopeVersion: number): Uint8Array {
  return new TextEncoder().encode(
    ["synch.sync-blob", `v${envelopeVersion}`, context.blobId].join("\n"),
  );
}

function parseBinaryBlobEnvelope(value: Uint8Array): {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
} {
  if (value.byteLength < SYNC_BLOB_V2_CIPHERTEXT_OFFSET) {
    throw new Error("Encrypted sync blob v2 payload is too short.");
  }
  for (let index = 0; index < SYNC_BLOB_V2_MAGIC.byteLength; index += 1) {
    if (value[index] !== SYNC_BLOB_V2_MAGIC[index]) {
      throw new Error("Encrypted sync blob v2 payload has an invalid magic header.");
    }
  }
  if (value[SYNC_BLOB_V2_VERSION_OFFSET] !== SYNC_BLOB_BINARY_ENVELOPE_VERSION) {
    throw new Error(
      `Unsupported sync blob binary envelope version: ${value[SYNC_BLOB_V2_VERSION_OFFSET] ?? "unknown"}.`,
    );
  }
  return {
    nonce: value.slice(SYNC_BLOB_V2_NONCE_OFFSET, SYNC_BLOB_V2_CIPHERTEXT_OFFSET),
    ciphertext: value.slice(SYNC_BLOB_V2_CIPHERTEXT_OFFSET),
  };
}

function throwUnsupportedSyncBlobFormatVersion(syncFormatVersion: number): never {
  throw new Error(`Unsupported sync blob format version: ${syncFormatVersion}.`);
}

function parseEncryptedEnvelope(value: string, envelopeVersion = ENVELOPE_VERSION): EncryptedEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Encrypted sync payload is not valid JSON.");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Encrypted sync payload must decode to an object.");
  }

  const record = parsed as Partial<EncryptedEnvelope>;
  if (record.version !== envelopeVersion) {
    throw new Error(`Unsupported sync payload version: ${record.version ?? "unknown"}.`);
  }
  if (typeof record.nonce !== "string" || !record.nonce.trim()) {
    throw new Error("Encrypted sync payload is missing a nonce.");
  }
  if (typeof record.ciphertext !== "string" || !record.ciphertext.trim()) {
    throw new Error("Encrypted sync payload is missing ciphertext.");
  }

  return {
    version: record.version,
    nonce: record.nonce,
    ciphertext: record.ciphertext,
  };
}
