import type { ConflictFileWriter } from "../core/conflict-file";
import { decryptSyncMetadata } from "../core/crypto";
import type { SyncTokenResponse } from "../remote/client";
import type { RemoteEntryState } from "../remote/changes";
import type { SyncPullClient } from "../remote/pull-client";
import type { PendingMutationRow, SyncProgressCounts } from "../store/store";
import type {
  SyncBlobStore,
  SyncEntryStore,
  SyncLocalEntryStore,
  SyncMutationStore,
  SyncRemoteEntryStore,
} from "../store/ports";
import {
  renameVaultPath,
  removeVaultPathIfExists,
  type SyncVaultWriter,
  writeVaultBytes,
} from "../vault/vault-writer";
import type { SyncEventGateLike } from "./event-gate";
import { PullBlobPreparer } from "./pull-blob-preparer";
import { PullManifestPlanner, type PullManifestStore } from "./pull-manifest-planner";
import { PullPendingMutationHandler } from "./pull-pending-mutation-handler";
import {
  createPathDependencyBatches,
  DEFAULT_PREPARE_CONCURRENCY,
  groupPendingConflictsByPlan,
  mapWithConcurrency,
  metadataContextFromRemoteState,
  packPathDependencyBatches,
  pathsToRemoveForPlan,
  type PullConflictEvent,
  type PullEntryStateManifestItem,
  type PlannedEntryState,
  type PreparedEntryBlob,
  type PreparedManifestApplication,
  type PreparedPendingConflict,
  type PreparedPathBatch,
  type SnapshotEntryState,
  uniquePendingConflicts,
  uniqueSyncPaths,
} from "./pull-entry-state-internal";

export interface PullEntryStateApplierDeps {
  getApiBaseUrl: () => string;
  getRemoteVaultKey: () => Uint8Array;
  vaultAdapter: PullEntryStateVaultAdapter;
  eventGate?: SyncEventGateLike;
  pullClient: Pick<SyncPullClient, "downloadBlob">;
  shouldApplyRemotePath?: (path: string) => boolean;
  prepareConcurrency?: number;
  onProgress?: (progress: SyncProgressCounts) => Promise<void>;
  onConflict?: (event: PullConflictEvent) => void;
  now?: () => number;
}

export interface PullEntryStateApplyResult {
  entriesApplied: number;
  filesWritten: number;
  filesDeleted: number;
  conflictsCreated: number;
}

export type { PullConflictEvent, PullEntryStateManifestItem };

export interface PullEntryStateVaultAdapter
  extends ConflictFileWriter,
    SyncVaultWriter {
  readBytes(path: string): Promise<Uint8Array>;
}

export interface PullEntryStateStore
  extends PullManifestStore,
    Pick<
      SyncEntryStore,
      "deleteEntry" | "getEntryStateById" | "upsertEntry"
    >,
    Pick<
      SyncRemoteEntryStore,
      "applyRemoteState" | "clearRemoteState" | "getRemoteStateById"
    >,
    Pick<
      SyncLocalEntryStore,
      "applyLocalState" | "clearLocalState" | "getLocalStateById"
    >,
    Pick<
      SyncMutationStore,
      | "clearDirtyEntryByMutationId"
      | "listDirtyEntries"
      | "markEntryDirty"
      | "replaceDirtyEntry"
    >,
    Pick<SyncBlobStore, "getBlob" | "putBlob"> {}

export type PullEntryStateWindowApplyResult = PullEntryStateApplyResult & {
  deferred: PullEntryStateManifestItem[];
};

export class PullEntryStateApplier {
  private readonly blobPreparer: PullBlobPreparer;
  private readonly manifestPlanner: PullManifestPlanner;
  private readonly pendingMutations: PullPendingMutationHandler;

  constructor(private readonly deps: PullEntryStateApplierDeps) {
    this.blobPreparer = new PullBlobPreparer(deps);
    this.manifestPlanner = new PullManifestPlanner(deps);
    this.pendingMutations = new PullPendingMutationHandler(deps);
  }

  async createManifestItems(
    states: RemoteEntryState[],
  ): Promise<PullEntryStateManifestItem[]> {
    const remoteVaultKey = this.deps.getRemoteVaultKey();

    return await mapWithConcurrency(
      states,
      this.deps.prepareConcurrency ?? DEFAULT_PREPARE_CONCURRENCY,
      async (state) => ({
        state,
        metadata: await decryptSyncMetadata(
          remoteVaultKey,
          state.encryptedMetadata,
          metadataContextFromRemoteState(state),
        ),
      }),
    );
  }

  async applyEntryStates(
    store: PullEntryStateStore,
    token: SyncTokenResponse,
    states: RemoteEntryState[],
  ): Promise<PullEntryStateApplyResult> {
    return await this.applyManifest(
      store,
      token,
      await this.createManifestItems(states),
    );
  }

  async applyManifest(
    store: PullEntryStateStore,
    token: SyncTokenResponse,
    manifest: PullEntryStateManifestItem[],
  ): Promise<PullEntryStateApplyResult> {
    const applied = await this.applyManifestWindow(store, token, manifest, {
      finalWindow: true,
    });
    return {
      entriesApplied: applied.entriesApplied,
      filesWritten: applied.filesWritten,
      filesDeleted: applied.filesDeleted,
      conflictsCreated: applied.conflictsCreated,
    };
  }

  async applyManifestWindow(
    store: PullEntryStateStore,
    token: SyncTokenResponse,
    manifest: PullEntryStateManifestItem[],
    options: {
      finalWindow: boolean;
      progress?: {
        completedOffset: number;
        totalEntries: number;
      };
    },
  ): Promise<PullEntryStateWindowApplyResult> {
    if (manifest.length === 0) {
      return {
        entriesApplied: 0,
        filesWritten: 0,
        filesDeleted: 0,
        conflictsCreated: 0,
        deferred: [],
      };
    }

    const prepared = await this.prepareManifestApplication(store, token, manifest, {
      deferExternalPathOwners: !options.finalWindow,
    });
    const filesDeleted = await this.applyPreparedManifest(
      store,
      prepared,
      options.progress,
    );

    return {
      entriesApplied: prepared.plans.length,
      filesWritten: prepared.pathsToWrite.length,
      filesDeleted,
      conflictsCreated: prepared.plans.reduce(
        (count, plan) =>
          count +
          (plan.pathConflict?.conflictPath ? 1 : 0) +
          (plan.pendingConflict?.conflictPath ? 1 : 0),
        0,
      ),
      deferred: prepared.deferred,
    };
  }

  private async prepareManifestApplication(
    store: PullEntryStateStore,
    token: SyncTokenResponse,
    manifest: PullEntryStateManifestItem[],
    options: { deferExternalPathOwners: boolean },
  ): Promise<PreparedManifestApplication> {
    const { plans: allPlans, deferred } = await this.manifestPlanner.planManifest(
      store,
      manifest,
      options,
    );
    const plans = allPlans.filter((plan) => this.shouldApplyPlanToVault(plan));
    await this.applySkippedRemoteStates(store, allPlans, plans);
    await this.markAlreadyCurrentVaultWrites(store, plans);
    const pathsToWrite = uniqueSyncPaths(
      plans
        .filter((plan) => !plan.skipVaultWrite)
        .map((plan) => plan.finalPath),
    );
    const pendingConflicts: PreparedPendingConflict[] = [];
    const preparedPendingMutationIds = new Set<string>();
    const batches: PreparedPathBatch[] = [];
    const preparedBlobs = await this.blobPreparer.preparePathBatchBlobs(
      store,
      token,
      plans,
    );
    const blobByPlan = new Map(preparedBlobs.map((blob) => [blob.plan, blob]));

    for (const plan of plans) {
      if (plan.adoptedLocalEntry?.hashMatches) {
        continue;
      }

      const pendingConflict = await this.pendingMutations.prepareConflictingPendingMutation(
        store,
        token,
        plan,
        blobByPlan.get(plan) ?? null,
      );
      if (pendingConflict) {
        if (preparedPendingMutationIds.has(pendingConflict.pending.mutationId)) {
          continue;
        }
        preparedPendingMutationIds.add(pendingConflict.pending.mutationId);
        plan.pendingConflict = pendingConflict.event;
        pendingConflicts.push(pendingConflict);
      }
    }

    const pathBatches = packPathDependencyBatches(
      createPathDependencyBatches(plans),
      this.deps.prepareConcurrency ?? DEFAULT_PREPARE_CONCURRENCY,
    );

    for (const batchPlans of pathBatches) {
      const pathsToRemove = uniqueSyncPaths(batchPlans.flatMap(pathsToRemoveForPlan));
      const blobs = batchPlans
        .map((plan) => blobByPlan.get(plan))
        .filter((blob): blob is PreparedEntryBlob => !!blob);

      batches.push({ plans: batchPlans, pathsToRemove, blobs });
    }

    return {
      plans,
      pathsToWrite,
      pendingConflicts,
      batches,
      deferred,
    };
  }

  private shouldApplyPlanToVault(plan: PlannedEntryState): boolean {
    return (
      !plan.metadata.path ||
      this.deps.shouldApplyRemotePath?.(plan.metadata.path) !== false
    );
  }

  private async applySkippedRemoteStates(
    store: PullEntryStateStore,
    allPlans: PlannedEntryState[],
    appliedPlans: PlannedEntryState[],
  ): Promise<void> {
    if (allPlans.length === appliedPlans.length) {
      return;
    }

    const applied = new Set(appliedPlans);
    for (const plan of allPlans) {
      if (applied.has(plan)) {
        continue;
      }

      await store.applyRemoteState({
        entryId: plan.state.entryId,
        path: plan.metadata.path,
        revision: plan.state.revision,
        blobId: plan.state.deleted ? null : plan.state.blobId,
        hash: plan.hash,
        deleted: plan.state.deleted,
        updatedAt: plan.state.updatedAt,
      });
    }
  }

  private async markAlreadyCurrentVaultWrites(
    store: PullEntryStateStore,
    plans: PlannedEntryState[],
  ): Promise<void> {
    for (const plan of plans) {
      // Only adopted files already at the target path can skip the vault write.
      // Path-collision plans still need their conflict copy materialized.
      if (
        (plan.adoptedLocalEntry?.hashMatches &&
          plan.adoptedLocalEntry.entry.path === plan.finalPath) ||
        (await this.isAlreadyAppliedToVault(store, plan))
      ) {
        plan.skipVaultWrite = true;
      }
    }
  }

  private async isAlreadyAppliedToVault(
    store: PullEntryStateStore,
    plan: PlannedEntryState,
  ): Promise<boolean> {
    if (
      plan.state.deleted ||
      !plan.finalPath ||
      plan.pathConflict ||
      plan.adoptedLocalEntry ||
      !plan.state.blobId ||
      !plan.hash
    ) {
      return false;
    }

    const pending = await store.getDirtyEntryMutation(plan.state.entryId);
    if (pending) {
      return false;
    }

    const remote = await store.getRemoteStateById(plan.state.entryId);
    if (
      !remote ||
      remote.deleted ||
      remote.revision !== plan.state.revision ||
      remote.path !== plan.finalPath ||
      remote.blobId !== plan.state.blobId ||
      remote.hash !== plan.hash
    ) {
      return false;
    }

    const local = await store.getLocalStateById(plan.state.entryId);
    return (
      !!local &&
      !local.deleted &&
      local.path === plan.finalPath &&
      local.blobId === plan.state.blobId &&
      local.hash === plan.hash
    );
  }

  private async applyPreparedManifest(
    store: PullEntryStateStore,
    prepared: PreparedManifestApplication,
    progress:
      | {
          completedOffset: number;
          totalEntries: number;
        }
      | undefined,
  ): Promise<number> {
    const originalEntries = await this.snapshotManifestEntries(store, prepared.plans);
    const originalDirtyEntries = await this.snapshotDirtyEntries(store, prepared);
    const pendingConflictsByPlan = groupPendingConflictsByPlan(prepared.pendingConflicts);

    try {
      let filesDeleted = 0;
      let entriesApplied = 0;
      filesDeleted = await this.runWithSuppressedPaths(
        [
          ...prepared.batches.flatMap((batch) => batch.pathsToRemove),
          ...prepared.batches.flatMap((batch) =>
            batch.plans.flatMap((plan) => [plan.vaultMove?.from, plan.vaultMove?.to]),
          ),
          ...prepared.pathsToWrite,
        ],
        async () => {
          let removedTotal = 0;
          for (const batch of prepared.batches) {
            const batchPendingConflicts = uniquePendingConflicts(
              batch.plans.flatMap((plan) => pendingConflictsByPlan.get(plan) ?? []),
            );
            for (const pendingConflict of batchPendingConflicts) {
              await this.pendingMutations.applyPreparedPendingConflict(store, pendingConflict);
            }
            await this.applyAdoptedLocalEntries(store, batch.plans);
            await this.clearChangingStorePaths(store, batch.plans);

            for (const plan of batch.plans) {
              if (plan.vaultMove) {
                await renameVaultPath(
                  this.deps.vaultAdapter,
                  plan.vaultMove.from,
                  plan.vaultMove.to,
                );
              }
            }

            let removed = 0;
            for (const path of batch.pathsToRemove) {
              if (await removeVaultPathIfExists(this.deps.vaultAdapter, path)) {
                removed += 1;
              }
            }

            for (const { plan, bytes } of batch.blobs) {
              if (!plan.finalPath || plan.skipVaultWrite) {
                continue;
              }
              await writeVaultBytes(this.deps.vaultAdapter, plan.finalPath, bytes);
            }

            removedTotal += removed;

            for (const plan of batch.plans) {
              await store.upsertEntry({
                entryId: plan.state.entryId,
                path: plan.state.deleted ? plan.metadata.path : plan.finalPath,
                revision: plan.state.revision,
                blobId: plan.state.deleted ? null : plan.state.blobId,
                hash: plan.hash,
                deleted: plan.state.deleted,
                updatedAt: plan.state.updatedAt,
                localMtime: this.localMtimeForAppliedPlan(plan),
                localSize: this.localSizeForAppliedPlan(plan),
              });
            }
            for (const pendingConflict of batchPendingConflicts) {
              await this.pendingMutations.applyPreparedPendingMerge(store, pendingConflict);
            }

            entriesApplied += batch.plans.length;
            await this.deps.onProgress?.({
              completedEntries: (progress?.completedOffset ?? 0) + entriesApplied,
              totalEntries: progress?.totalEntries ?? prepared.plans.length,
            });
          }

          return removedTotal;
        },
      );

      return filesDeleted;
    } catch (error) {
      await this.restoreManifestEntries(store, originalEntries);
      await this.restoreDirtyEntries(store, originalDirtyEntries);
      throw error;
    }
  }

  private localMtimeForAppliedPlan(plan: PlannedEntryState): number | null {
    if (!plan.skipVaultWrite) {
      return null;
    }

    return (
      plan.adoptedLocalEntry?.entry.localMtime ??
      plan.existing?.localMtime ??
      null
    );
  }

  private localSizeForAppliedPlan(plan: PlannedEntryState): number | null {
    if (!plan.skipVaultWrite) {
      return null;
    }

    return (
      plan.adoptedLocalEntry?.entry.localSize ??
      plan.existing?.localSize ??
      null
    );
  }

  private async applyAdoptedLocalEntries(
    store: PullEntryStateStore,
    plans: PlannedEntryState[],
  ): Promise<void> {
    const adoptedEntryIds = new Set<string>();

    for (const plan of plans) {
      const adoption = plan.adoptedLocalEntry;
      if (!adoption || adoptedEntryIds.has(adoption.entry.entryId)) {
        continue;
      }

      if (adoption.hashMatches) {
        await store.clearDirtyEntryByMutationId(adoption.pending.mutationId);
      }
      await store.deleteEntry(adoption.entry.entryId);
      adoptedEntryIds.add(adoption.entry.entryId);
    }
  }

  private async clearChangingStorePaths(
    store: PullEntryStateStore,
    plans: PlannedEntryState[],
  ): Promise<void> {
    for (const plan of plans) {
      if (!plan.existing?.path || plan.existing.path === plan.finalPath) {
        continue;
      }

      await store.upsertEntry({
        ...plan.existing,
        path: null,
        localMtime: null,
        localSize: null,
      });
    }
  }

  private async snapshotManifestEntries(
    store: PullEntryStateStore,
    plans: PlannedEntryState[],
  ): Promise<Map<string, SnapshotEntryState>> {
    const entryIds = new Set<string>();
    for (const plan of plans) {
      entryIds.add(plan.state.entryId);
      if (plan.adoptedLocalEntry) {
        entryIds.add(plan.adoptedLocalEntry.entry.entryId);
      }
    }

    const entries = new Map<string, SnapshotEntryState>();
    for (const entryId of entryIds) {
      entries.set(entryId, {
        remote: await store.getRemoteStateById(entryId),
        local: await store.getLocalStateById(entryId),
      });
    }
    return entries;
  }

  private async snapshotDirtyEntries(
    store: PullEntryStateStore,
    prepared: PreparedManifestApplication,
  ): Promise<Map<string, PendingMutationRow | null>> {
    const entryIds = new Set<string>();
    for (const plan of prepared.plans) {
      entryIds.add(plan.state.entryId);
      if (plan.adoptedLocalEntry) {
        entryIds.add(plan.adoptedLocalEntry.entry.entryId);
      }
    }
    for (const pendingConflict of prepared.pendingConflicts) {
      entryIds.add(pendingConflict.pending.entryId);
    }

    const dirtyEntries = new Map<string, PendingMutationRow | null>();
    for (const entryId of entryIds) {
      dirtyEntries.set(entryId, await store.getDirtyEntryMutation(entryId));
    }
    return dirtyEntries;
  }

  private async restoreManifestEntries(
    store: PullEntryStateStore,
    entries: ReadonlyMap<string, SnapshotEntryState>,
  ): Promise<void> {
    for (const [entryId, entry] of entries) {
      if (entry.remote) {
        await store.applyRemoteState(entry.remote);
      } else {
        await store.clearRemoteState(entryId);
      }

      if (entry.local) {
        await store.applyLocalState(entry.local);
      } else {
        await store.clearLocalState(entryId);
      }

      if (!entry.remote && !entry.local && !(await store.getDirtyEntryMutation(entryId))) {
        await store.deleteEntry(entryId);
      }
    }
  }

  private async restoreDirtyEntries(
    store: PullEntryStateStore,
    entries: ReadonlyMap<string, PendingMutationRow | null>,
  ): Promise<void> {
    for (const [entryId, mutation] of entries) {
      const current = await store.getDirtyEntryMutation(entryId);
      if (current) {
        await store.clearDirtyEntryByMutationId(current.mutationId);
      }
      if (mutation) {
        await store.markEntryDirty(mutation);
      }
    }
  }

  private async runWithSuppressedPaths<T>(
    paths: ReadonlyArray<string | null | undefined>,
    action: () => Promise<T>,
  ): Promise<T> {
    if (!this.deps.eventGate) {
      return await action();
    }

    return await this.deps.eventGate.suppressPaths(uniqueSyncPaths(paths), action);
  }
}
