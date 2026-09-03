import {
  resolveSyncContentRuntime,
  type SyncContentRuntime,
  type SyncContentRuntimeDeps,
} from "../core/content-runtime";
import { createSyncCryptoContext, decryptSyncBlob } from "../core/crypto";
import type { SyncTokenResponse } from "../remote/client";
import type { RemoteEntryState } from "../remote/changes";
import type { SyncPullClient } from "../remote/pull-client";
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
  getApiBaseUrl: () => string;
  getRemoteVaultKey: () => Uint8Array;
  vaultAdapter: SyncVaultAccess;
  pullClient: Pick<SyncPullClient, "downloadBlob">;
  prepareConcurrency?: number;
}

export class PullBlobPreparer {
  private readonly contentRuntime: SyncContentRuntime;

  constructor(private readonly deps: PullBlobPreparerDeps) {
    this.contentRuntime = resolveSyncContentRuntime(deps);
  }

  async preparePathBatchBlobs(
    store: SyncBlobStore,
    token: SyncTokenResponse,
    plans: PlannedEntryState[],
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
      this.deps.prepareConcurrency ?? DEFAULT_PREPARE_CONCURRENCY,
      async (plan): Promise<PreparedEntryBlob | null> => {
        if (this.canReuseAdoptedLocalContent(plan)) {
          await this.prepareAdoptedLocalBase(store, plan);
          return null;
        }

        return {
          plan,
          bytes: await this.downloadAndVerifyEntryBlob(store, token, plan),
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

  private async downloadEntryBlob(
    token: SyncTokenResponse,
    state: RemoteEntryState,
  ): Promise<Uint8Array> {
    if (!state.blobId) {
      throw new Error(`Entry state ${state.entryId}@${state.revision} is missing a blob.`);
    }

    return await this.deps.pullClient.downloadBlob(
      this.deps.getApiBaseUrl(),
      token.token,
      token.vaultId,
      state.blobId,
    );
  }

  private async downloadAndVerifyEntryBlob(
    store: SyncBlobStore,
    token: SyncTokenResponse,
    plan: PlannedEntryState,
  ): Promise<Uint8Array> {
    const blobId = requireBlobId(plan.state);
    const encryptedBytes = await this.downloadEntryBlob(token, plan.state);
    let bytes = await decryptSyncBlob(
      this.deps.getRemoteVaultKey(),
      encryptedBytes,
      { blobId },
    );
    const hashed = await this.contentRuntime.hashAndReturnBytes(bytes);
    bytes = hashed.bytes;
    const actualHash = hashed.hash;
    if (actualHash !== plan.hash) {
      throw new Error(
        `Entry state ${plan.state.entryId}@${plan.state.revision} hash does not match metadata.`,
      );
    }
    if (plan.finalPath && isAutoMergeTextPath(plan.finalPath)) {
      await store.putBlob({
        blobId,
        hash: actualHash,
        encryptedBytes,
        role: "remote",
        refEntryId: plan.state.entryId,
        cachedAt: Date.now(),
      });
    }

    return bytes;
  }
}

export class PullLocalSnapshotChangedError extends Error {
  readonly code = "local_snapshot_changed" as const;

  constructor(readonly path: string) {
    super(`Local file changed while adopting remote entry: ${path}`);
    this.name = "PullLocalSnapshotChangedError";
  }
}
