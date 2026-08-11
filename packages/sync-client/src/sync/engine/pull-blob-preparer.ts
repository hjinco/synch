import { hashBytes } from "../core/content";
import { decryptSyncBlob } from "../core/crypto";
import type { SyncTokenResponse } from "../remote/client";
import type { RemoteEntryState } from "../remote/changes";
import type { SyncPullClient } from "../remote/pull-client";
import type { SyncBlobStore } from "../store/ports";
import { isAutoMergeTextPath } from "./text-merge-policy";
import {
  DEFAULT_PREPARE_CONCURRENCY,
  mapWithConcurrency,
  type PlannedEntryState,
  type PreparedEntryBlob,
  requireBlobId,
} from "./pull-entry-state-internal";

interface PullBlobPreparerDeps {
  getApiBaseUrl: () => string;
  getRemoteVaultKey: () => Uint8Array;
  pullClient: Pick<SyncPullClient, "downloadBlob">;
  prepareConcurrency?: number;
}

export class PullBlobPreparer {
  constructor(private readonly deps: PullBlobPreparerDeps) {}

  async preparePathBatchBlobs(
    store: SyncBlobStore,
    token: SyncTokenResponse,
    plans: PlannedEntryState[],
  ): Promise<PreparedEntryBlob[]> {
    const blobPlans = plans.filter((plan) => {
      if (!plan.finalPath || plan.state.deleted) {
        return false;
      }
      if (!plan.skipVaultWrite) {
        return true;
      }

      // Same-path adopted entries already have matching local bytes. For non-text
      // files, accepted remote metadata relies on the server's staged/live blob
      // invariant, so a broken invariant would not be caught by client-side
      // download/decrypt/hash verification here. Text files still download so
      // merge bases stay cached locally.
      return plan.adoptedLocalEntry?.hashMatches && isAutoMergeTextPath(plan.finalPath);
    });

    return await mapWithConcurrency(
      blobPlans,
      this.deps.prepareConcurrency ?? DEFAULT_PREPARE_CONCURRENCY,
      async (plan) => {
        return {
          plan,
          bytes: await this.downloadAndVerifyEntryBlob(store, token, plan),
        };
      },
    );
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
    const bytes = await decryptSyncBlob(
      this.deps.getRemoteVaultKey(),
      encryptedBytes,
      { blobId },
      { syncFormatVersion: token.syncFormatVersion },
    );
    const actualHash = await hashBytes(bytes);
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
