import { FileTransferLog } from "../diagnostics/file-transfer";
import type { SyncDiagnostics } from "../diagnostics/types";
import {
  type SyncContentRuntime,
  type ContentReservation,
  type SyncContentRuntimeDeps,
} from "../core/content-runtime";
import { createSyncCryptoContext, decryptSyncBlob, encryptedSyncBlobSize } from "../core/crypto";
import type { SyncTokenResponse } from "../remote/client";
import type { SyncBlobClient } from "../remote/blob-client";
import type { SyncBlobStore } from "../store/ports";
import type { SyncVaultAccess } from "../vault/ports";
import { isAutoMergeTextPath } from "./text-merge-policy";
import {
  DEFAULT_PREPARE_CONCURRENCY,
  mapWithConcurrency,
  type PlannedEntryState,
  type PreparedEntryBlob,
  requireBlobId,
} from "./pull-entry-state-internal";

interface PullBlobPreparerDeps extends SyncContentRuntimeDeps {
  diagnostics?: SyncDiagnostics;
  getRemoteVaultKey: () => Uint8Array;
  vaultAdapter: SyncVaultAccess;
  blobClient: Pick<SyncBlobClient, "downloadBlob">;
  prepareConcurrency?: number;
}

export class PullBlobPreparer {
  private readonly contentRuntime: SyncContentRuntime;

  constructor(private readonly deps: PullBlobPreparerDeps) {
    this.contentRuntime = deps.contentRuntime;
  }

  async preparePathBatchBlobs(
    store: SyncBlobStore,
    token: SyncTokenResponse,
    plans: PlannedEntryState[],
    reservation?: ContentReservation,
    checkSelection?: () => void,
  ): Promise<PreparedEntryBlob[]> {
    const contentPlans = plans.filter((plan) => {
      if (!plan.finalPath || plan.state.deleted) {
        return false;
      }
      if (!plan.skipVaultWrite) {
        return true;
      }

      // The planner only compares recorded hashes. Read adopted local content
      // here so skipping both the download and vault write is based on the
      // actual bytes present at apply time.
      return this.canReuseAdoptedLocalContent(plan);
    });

    const prepared = await mapWithConcurrency(
      contentPlans,
      reservation ? 1 : this.deps.prepareConcurrency ?? DEFAULT_PREPARE_CONCURRENCY,
      async (plan): Promise<PreparedEntryBlob | null> => {
        checkSelection?.();
        if (this.canReuseAdoptedLocalContent(plan)) {
          await this.prepareAdoptedLocalBase(store, plan, reservation);
          return null;
        }

        const fileSize = plan.state.blobSize == null ? null : Math.max(0, plan.state.blobSize - encryptedSyncBlobSize(0));
        const transfer = new FileTransferLog(this.deps.diagnostics, "download", plan.finalPath ?? plan.metadata.path, fileSize);
        return {
          transfer,
          plan,
          ...await this.downloadAndVerifyEntryBlob(store, token, plan, transfer, reservation, checkSelection),
        };
      },
    );

    return prepared.filter((blob): blob is PreparedEntryBlob => blob !== null);
  }

  private canReuseAdoptedLocalContent(plan: PlannedEntryState): boolean {
    return (
      plan.skipVaultWrite &&
      plan.adoptedLocalEntry?.hashMatches === true &&
      !!plan.finalPath &&
      plan.adoptedLocalEntry.entry.path === plan.finalPath
    );
  }

  private async prepareAdoptedLocalBase(
    store: SyncBlobStore,
    plan: PlannedEntryState,
    reservation?: ContentReservation,
  ): Promise<void> {
    const path = plan.finalPath;
    const expectedHash = plan.hash;
    if (!path || !expectedHash) {
      throw new Error(
        `Adopted entry ${plan.state.entryId}@${plan.state.revision} is missing local content metadata.`,
      );
    }

    if (!(await this.deps.vaultAdapter.exists(path))) {
      throw new PullLocalSnapshotChangedError(path);
    }

    const hashed = await this.contentRuntime.readAndHash(
      await this.deps.vaultAdapter.getFileSize(path),
      async () => await this.deps.vaultAdapter.readBytes(path),
      reservation,
    );
    if (hashed.hash !== expectedHash) {
      throw new PullLocalSnapshotChangedError(path);
    }

    if (!isAutoMergeTextPath(path)) {
      return;
    }

    const blobId = requireBlobId(plan.state);
    const syncCrypto = createSyncCryptoContext(this.deps.getRemoteVaultKey());
    try {
      await store.putBlob({
        blobId,
        hash: expectedHash,
        encryptedBytes: await syncCrypto.encryptBlob(hashed.bytes, { blobId }),
        role: "remote",
        refEntryId: plan.state.entryId,
        cachedAt: Date.now(),
      });
    } finally {
      syncCrypto.dispose();
    }
  }

  private async downloadAndVerifyEntryBlob(
    store: SyncBlobStore,
    token: SyncTokenResponse,
    plan: PlannedEntryState,
    transfer: FileTransferLog,
    reservation?: ContentReservation,
    checkSelection?: () => void,
  ): Promise<Pick<PreparedEntryBlob, "bytes" | "journalCiphertext">> {
    const blobId = requireBlobId(plan.state);
    let journalCiphertext: Uint8Array | undefined;
    let encryptedForMerge: Uint8Array | undefined;
    let plaintext: Uint8Array;
    {
      const encrypted = await this.deps.blobClient.downloadBlob(token.vaultId, blobId, transfer, checkSelection);
      checkSelection?.();
      if (plan.state.blobSize != null && encrypted.byteLength !== plan.state.blobSize) {
        throw new Error(`Entry state ${plan.state.entryId} blob size does not match metadata.`);
      }
      transfer.observeFileSize(Math.max(0, encrypted.byteLength - encryptedSyncBlobSize(0)));
      reservation?.retain(encrypted.byteLength * 3);
      plaintext = await transfer.run("decrypt", () =>
        decryptSyncBlob(this.deps.getRemoteVaultKey(), encrypted, { blobId }));
      if (plan.finalPath && isAutoMergeTextPath(plan.finalPath)) encryptedForMerge = encrypted;
      else if (!this.deps.vaultAdapter.atomicWrites) journalCiphertext = encrypted;
    }
    const hashed = await transfer.run("verify", async () => {
      const result = await this.contentRuntime.hashAndReturnBytes(plaintext);
      if (result.hash !== plan.hash) {
        throw new Error(
          `Entry state ${plan.state.entryId}@${plan.state.revision} hash does not match metadata.`,
        );
      }
      return result;
    });
    if (encryptedForMerge) {
      await store.putBlob({
        blobId,
        hash: hashed.hash,
        encryptedBytes: encryptedForMerge,
        role: "remote",
        refEntryId: plan.state.entryId,
        cachedAt: Date.now(),
      });
    }

    return { bytes: hashed.bytes, journalCiphertext };
  }
}

export class PullLocalSnapshotChangedError extends Error {
  readonly code = "local_snapshot_changed" as const;

  constructor(readonly path: string) {
    super(`Local file changed while adopting remote entry: ${path}`);
    this.name = "PullLocalSnapshotChangedError";
  }
}
