import type { PendingMutationRow } from "../store/store";

/** Bounded ciphertext retention between upload and commit acknowledgement. */
export class PushBlobRetryCache {
  private readonly entries = new Map<string, {
    vaultId: string;
    encryptedMetadata: string;
    bytes: Uint8Array;
  }>();
  private retainedBytes = 0;

  constructor(private readonly maxBytes = 8 * 1024 * 1024) {}

  get(mutation: PendingMutationRow, vaultId: string): Uint8Array | null {
    const entry = mutation.blobId ? this.entries.get(mutation.blobId) : undefined;
    // Metadata has already been authenticated by the preparer. Matching its
    // ciphertext also scopes reuse to the same key, revision, path and hash.
    return entry?.vaultId === vaultId &&
      entry.encryptedMetadata === mutation.encryptedMetadata
      ? entry.bytes : null;
  }

  put(mutation: PendingMutationRow, vaultId: string, bytes: Uint8Array): void {
    if (!mutation.blobId) return;
    this.delete(mutation.blobId);
    if (bytes.byteLength > this.maxBytes) return;
    while (this.retainedBytes + bytes.byteLength > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
    this.entries.set(mutation.blobId, {
      vaultId,
      encryptedMetadata: mutation.encryptedMetadata,
      bytes,
    });
    this.retainedBytes += bytes.byteLength;
  }

  delete(blobId: string): void {
    const entry = this.entries.get(blobId);
    if (entry) this.retainedBytes -= entry.bytes.byteLength;
    this.entries.delete(blobId);
  }
}
