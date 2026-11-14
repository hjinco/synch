import { isPortableVaultPath } from "../core/portable-path";
import { decryptSyncMetadata } from "../core/crypto";
import { metadataContextFromMutation } from "./push-mutation-shared";
import type { SyncStore } from "../store/store";
import type { PendingMutationBlockedReason } from "../store/store";

export interface SyncBlockedSyncFile {
  path: string;
  encryptedSizeBytes: number | null;
  maxFileSizeBytes: number | null;
  reason: PendingMutationBlockedReason;
}

export async function listBlockedSyncFiles(
  store: SyncStore,
  remoteVaultKey: Uint8Array,
): Promise<SyncBlockedSyncFile[]> {
  const mutations = (await Promise.all([
    store.listBlockedDirtyEntriesByReason("file_too_large"),
    store.listBlockedDirtyEntriesByReason("incompatible_path"),
  ])).flat();
  const files: SyncBlockedSyncFile[] = [];
  for (const mutation of mutations) {
    if (mutation.op !== "upsert") {
      continue;
    }

    const metadata = await decryptSyncMetadata(
      remoteVaultKey,
      mutation.encryptedMetadata,
      metadataContextFromMutation(mutation),
    );
    files.push({
      path: metadata.path,
      reason: mutation.blockedReason ?? "file_too_large",
      encryptedSizeBytes: mutation.blockedEncryptedSizeBytes ?? null,
      maxFileSizeBytes: mutation.blockedMaxFileSizeBytes ?? null,
    });
  }

  // Pull already persists decrypted remote metadata even when applying the
  // file was rejected. Derive remote warnings from that state so they survive
  // restarts and disappear when the remote path is renamed or deleted.
  const byPath = new Map(files.map((file) => [file.path, file]));
  for (const remote of await store.listRemoteStates()) {
    if (!remote.deleted && remote.path && !isPortableVaultPath(remote.path)) {
      byPath.set(remote.path, {
        path: remote.path,
        reason: "incompatible_path",
        encryptedSizeBytes: null,
        maxFileSizeBytes: null,
      });
    }
  }
  return [...byPath.values()];
}
