import { decryptSyncMetadata } from "../core/crypto";
import { metadataContextFromMutation } from "./push-mutation-shared";
import type { SyncStore } from "../store/store";

export interface SyncFileSizeBlockedFile {
  path: string;
  encryptedSizeBytes: number | null;
  maxFileSizeBytes: number | null;
}

export async function listFileSizeBlockedFiles(
  store: SyncStore,
  remoteVaultKey: Uint8Array,
): Promise<SyncFileSizeBlockedFile[]> {
  const mutations = await store.listBlockedDirtyEntriesByReason("file_too_large");
  const files: SyncFileSizeBlockedFile[] = [];
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
      encryptedSizeBytes: mutation.blockedEncryptedSizeBytes ?? null,
      maxFileSizeBytes: mutation.blockedMaxFileSizeBytes ?? null,
    });
  }

  return files;
}
