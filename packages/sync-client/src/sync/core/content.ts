export interface SyncedEntryMetadata {
  path: string;
  hash: string | null;
}

export interface HashedBytes {
  hash: string;
  bytes: Uint8Array;
}

/**
 * Hashing is kept behind a small interface so browser hosts can provide a
 * worker-backed implementation while non-browser consumers can keep using
 * the WebCrypto implementation below.
 */
export interface SyncContentHasher {
  hash(bytes: Uint8Array): Promise<string>;
  /**
   * Hash bytes while returning the byte ownership to the caller. A worker
   * implementation can transfer the input buffer instead of copying it.
   */
  hashAndReturnBytes(bytes: Uint8Array): Promise<HashedBytes>;
  dispose?(): void | Promise<void>;
}

export function serializeSyncedEntryMetadata(metadata: SyncedEntryMetadata): string {
  return JSON.stringify(metadata);
}

export function parseSyncedEntryMetadata(value: string): SyncedEntryMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Sync metadata is not valid JSON.");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Sync metadata must decode to an object.");
  }

  const record = parsed as Record<string, unknown>;
  const path = typeof record.path === "string" ? record.path.trim() : "";
  if (!path) {
    throw new Error("Sync metadata is missing a file path.");
  }
  if (!Object.prototype.hasOwnProperty.call(record, "hash")) {
    throw new Error("Sync metadata is missing a hash.");
  }
  const hash =
    typeof record.hash === "string" && record.hash.trim()
      ? record.hash.trim()
      : record.hash === null
        ? null
        : "";
  if (hash === "") {
    throw new Error("Sync metadata hash must be a non-empty string or null.");
  }

  return {
    path,
    hash,
  };
}

export async function hashBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer instanceof ArrayBuffer &&
      bytes.byteOffset === 0 &&
      bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.slice().buffer,
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function createDefaultContentHasher(): SyncContentHasher {
  return {
    hash: hashBytes,
    hashAndReturnBytes: async (bytes) => ({
      hash: await hashBytes(bytes),
      bytes,
    }),
  };
}

export function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
