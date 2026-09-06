import type { SyncedEntryMetadata } from "../core/content";
import {
  SyncBlobUploadError,
  type SyncBlobClient,
} from "../remote/blob-client";
import {
  type SyncContentRuntime,
} from "../core/content-runtime";
import {
  createSyncCryptoContext,
  encryptedSyncBlobSize,
  type SyncCryptoContext,
} from "../core/crypto";
import { queueLocalUpsertMutation } from "../core/mutation-queue";
import type { SyncTokenResponse } from "../remote/client";
import type { PendingMutationRow } from "../store/store";
import type {
  PreparePushMutationResult,
  PushMutationCommitterDeps,
  PushMutationStore,
} from "./push-mutation-types";
import {
  metadataContextFromMutation,
  toCommitPayload,
} from "./push-mutation-shared";
import { isAutoMergeTextPath } from "./text-merge-policy";

export class PushMutationPreparer {
  private readonly blobClient: Pick<SyncBlobClient, "uploadBlob">;
  private readonly contentRuntime: SyncContentRuntime;
  private fallbackCryptoContext: SyncCryptoContext | null = null;

  constructor(private readonly deps: PushMutationCommitterDeps) {
    this.blobClient = deps.blobClient;
    this.contentRuntime = deps.contentRuntime;
  }

  async prepareMutationForCommit(
    store: PushMutationStore,
    token: SyncTokenResponse,
    mutation: PendingMutationRow,
    maxFileSizeBytes: number,
    onMetadataReady?: (metadata: SyncedEntryMetadata) => void,
  ): Promise<PreparePushMutationResult> {
    const syncCrypto = this.getSyncCryptoContext();
    const metadata = await syncCrypto.decryptMetadata(
      mutation.encryptedMetadata,
      metadataContextFromMutation(mutation),
    );

    onMetadataReady?.(metadata);

    if (mutation.op === "delete") {
      return {
        commitPayload: toCommitPayload(mutation),
        metadata,
        localHash: null,
        encryptedBytes: null,
      };
    }

    if (!mutation.blobId) {
      throw new Error(`Upsert mutation ${mutation.mutationId} is missing a blobId.`);
    }
    if (!mutation.hash) {
      throw new Error(`Upsert mutation ${mutation.mutationId} is missing a hash.`);
    }
    if (metadata.hash !== mutation.hash) {
      throw new Error(`Upsert mutation ${mutation.mutationId} metadata hash does not match.`);
    }

    const fileSize = await this.getFileSize(store, mutation, metadata.path);
    const hashed = await this.contentRuntime.readAndHash(
      fileSize,
      async () => await this.deps.fileReader.readBytes(metadata.path),
    );
    const { bytes, hash: actualHash } = hashed;
    if (actualHash !== mutation.hash) {
      await this.requeueChangedUpsert(store, mutation, metadata.path, actualHash);
      return null;
    }
    const blobId = mutation.blobId;
    const encryptedSizeBytes = encryptedSyncBlobSize(bytes.byteLength);
    if (maxFileSizeBytes > 0 && encryptedSizeBytes > maxFileSizeBytes) {
      await this.blockOversizedUpsert(
        store,
        mutation,
        encryptedSizeBytes,
        maxFileSizeBytes,
      );
      return { skipped: true, reason: "file_too_large" };
    }

    const staged = this.deps.remotelyStagedBlobIds.has(blobId);
    const retainEncryptedBytes = isAutoMergeTextPath(metadata.path);
    // Hash validation above remains mandatory, even when upload can be reused.
    // Binary payloads have no local consumer after staging; Markdown needs a
    // merge base, regenerating it only if the bounded retry cache missed.
    const encryptedBytes = staged && !retainEncryptedBytes
      ? null
      : (staged ? this.deps.blobRetryCache?.get(mutation, token.vaultId) : null)
        ?? await syncCrypto.encryptBlob(bytes, { blobId });

    if (!staged && encryptedBytes) {
      try {
        await this.blobClient.uploadBlob(
          token.vaultId,
          blobId,
          encryptedBytes,
        );
      } catch (error) {
        if (isQuotaExceededUploadError(error)) {
          return {
            skipped: true,
            reason: "storage_quota_exceeded",
          };
        }
        if (isFileTooLargeUploadError(error)) {
          await this.blockOversizedUpsert(
            store,
            mutation,
            encryptedBytes.byteLength,
            maxFileSizeBytes > 0 ? maxFileSizeBytes : null,
          );
          return {
            skipped: true,
            reason: "file_too_large",
          };
        }

        throw error;
      }
      this.deps.remotelyStagedBlobIds.add(blobId);
    }

    if (retainEncryptedBytes && encryptedBytes) {
      this.deps.blobRetryCache?.put(mutation, token.vaultId, encryptedBytes);
    }

    return {
      commitPayload: toCommitPayload(mutation),
      metadata,
      localHash: mutation.hash,
      // Only Markdown needs the encrypted payload after upload so it can be
      // retained as a remote merge base. Binary payloads have no local
      // consumer after the server has staged them.
      encryptedBytes: retainEncryptedBytes ? encryptedBytes : null,
    };
  }

  private async getFileSize(
    store: PushMutationStore,
    mutation: PendingMutationRow,
    path: string,
  ): Promise<number> {
    if (this.deps.fileReader.getFileSize) {
      return await this.deps.fileReader.getFileSize(path);
    }

    return (await store.getEntryById(mutation.entryId))?.localSize ?? 0;
  }

  private getSyncCryptoContext(): SyncCryptoContext {
    if (this.deps.getSyncCryptoContext) {
      return this.deps.getSyncCryptoContext();
    }

    this.fallbackCryptoContext ??= createSyncCryptoContext(this.deps.getRemoteVaultKey());
    return this.fallbackCryptoContext;
  }

  private async blockOversizedUpsert(
    store: PushMutationStore,
    mutation: PendingMutationRow,
    encryptedSizeBytes: number,
    maxFileSizeBytes: number | null,
  ): Promise<void> {
    await store.updateDirtyEntry({
      ...mutation,
      status: "blocked",
      blockedReason: "file_too_large",
      blockedEncryptedSizeBytes: encryptedSizeBytes,
      blockedMaxFileSizeBytes: maxFileSizeBytes,
    });
  }

  private async requeueChangedUpsert(
    store: PushMutationStore,
    mutation: PendingMutationRow,
    path: string,
    hash: string,
  ): Promise<void> {
    const existing = await store.getEntryById(mutation.entryId);
    const remote = await store.getRemoteStateById(mutation.entryId);
    const local = await store.getLocalStateById(mutation.entryId);
    const queued = await queueLocalUpsertMutation(store, {
      remoteVaultKey: this.deps.getRemoteVaultKey(),
      path,
      entryId: mutation.entryId,
      base: remote ?? {
        revision: mutation.baseRevision,
        deleted: false,
        blobId: mutation.baseBlobId ?? mutation.blobId,
        hash: mutation.baseHash ?? mutation.hash,
      },
      previousLocal: local ?? existing,
      hash,
    });

    await store.applyLocalState({
      entryId: queued.entryId,
      path,
      blobId: queued.blobId,
      hash,
      deleted: false,
      updatedAt: Date.now(),
      localMtime: existing?.localMtime ?? null,
      localSize: existing?.localSize ?? null,
    });
  }
}

function isQuotaExceededUploadError(error: unknown): boolean {
  return (
    error instanceof SyncBlobUploadError &&
    error.status === 413 &&
    error.code === "quota_exceeded"
  );
}

function isFileTooLargeUploadError(error: unknown): boolean {
  return (
    error instanceof SyncBlobUploadError &&
    error.status === 413 &&
    error.code !== "quota_exceeded"
  );
}
