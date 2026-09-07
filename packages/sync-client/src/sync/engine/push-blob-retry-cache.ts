import type { ContentReservation, IdleContent, SyncContentRuntime } from "../core/content-runtime";
import type { PendingMutationRow } from "../store/store";

type CachedBlob = IdleContent & {
  vaultId: string;
  encryptedMetadata: string;
  bytes: Uint8Array;
  reservation: ContentReservation;
};

/** Optional ciphertext reuse: capped at 8 MiB and charged to the shared byte budget. */
export class PushBlobRetryCache {
  private readonly entries = new Map<string, CachedBlob>();
  private retainedBytes = 0;

  constructor(
    private readonly runtime: SyncContentRuntime,
    private readonly maxBytes = 8 * 1024 * 1024,
  ) {}

  get(mutation: PendingMutationRow, vaultId: string): Uint8Array | null {
    const entry = mutation.blobId ? this.entries.get(mutation.blobId) : undefined;
    // Metadata has already been authenticated by the preparer. Matching its
    // ciphertext scopes reuse to the same key, revision, path and hash.
    return entry?.vaultId === vaultId && entry.encryptedMetadata === mutation.encryptedMetadata
      ? entry.bytes : null;
  }

  put(mutation: PendingMutationRow, vaultId: string, bytes: Uint8Array): void {
    const blobId = mutation.blobId;
    if (!blobId) return;
    this.delete(blobId);
    if (bytes.byteLength > this.maxBytes) return;
    while (this.retainedBytes + bytes.byteLength > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
    // A cache must never wait for memory while its caller holds an active file.
    const reservation = this.runtime.tryReserve(bytes.byteLength);
    if (!reservation) return;
    const entry: CachedBlob = {
      vaultId,
      encryptedMetadata: mutation.encryptedMetadata,
      bytes,
      reservation,
      reclaim: async () => { this.delete(blobId); },
      dispose: async () => { this.delete(blobId); },
    };
    this.entries.set(blobId, entry);
    this.retainedBytes += bytes.byteLength;
    this.runtime.registerIdleContent(entry);
  }

  delete(blobId: string): void {
    const entry = this.entries.get(blobId);
    if (!entry) return;
    this.entries.delete(blobId);
    this.retainedBytes -= entry.bytes.byteLength;
    this.runtime.unregisterIdleContent(entry);
    entry.reservation.release();
  }
}
