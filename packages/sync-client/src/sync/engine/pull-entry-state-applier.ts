import type { DeviceFileSelection } from "./device-file-selection";
import type { SyncDiagnostics } from "../diagnostics/types";
import type { SyncEventRecorderStore } from "./event-recorder";
import { PullLocalFileSnapshots, PullLocalFilesChangedError } from "./pull-local-file-snapshots";
import { retrySyncStateWork, syncStateCoordinator, withSyncState, type SyncStateSnapshot, type SyncStateResources } from "./sync-state-coordinator";
import type { SyncConflictPolicy } from "../core/conflict-policy";
import { decryptSyncMetadata } from "../core/crypto";
import type { ContentReservation, SyncContentRuntimeDeps } from "../core/content-runtime";
import type { SyncTokenResponse } from "../remote/client";
import type { RemoteEntryState } from "../remote/changes";
import type { SyncBlobClient } from "../remote/blob-client";
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
  writeVaultBytes,
} from "../vault/vault-writer";
import type { SyncVaultAccess } from "../vault/ports";
import type { SyncEventGateLike } from "./event-gate";
import { groupPullApplications, pullPlanFilePaths } from "./pull-application-groups";
import { runPullPreparationPipeline } from "./pull-preparation-pipeline";
import { capturePullStoreSnapshot } from "./pull-store-snapshot";
import { PullBlobPreparer } from "./pull-blob-preparer";
import { PullManifestPlanner, type PullManifestStore } from "./pull-manifest-planner";
import { PullPendingMutationHandler } from "./pull-pending-mutation-handler";
import {
  DEFAULT_PREPARE_CONCURRENCY,
  groupPendingConflictsByPlan,
  mapWithConcurrency,
  metadataContextFromRemoteState,
  pathsToRemoveForPlan,
  type PullConflictEvent,
  type PullEntryStateManifestItem,
  type PullRollbackEvent,
  type PlannedEntryState,
  type PreparedManifestApplication,
  uniquePendingConflicts,
  uniqueSyncPaths,
} from "./pull-entry-state-internal";

export interface PullEntryStateApplierDeps extends SyncContentRuntimeDeps {
  diagnostics?: SyncDiagnostics;
  getRemoteVaultKey: () => Uint8Array;
  getConflictPolicy?: () => SyncConflictPolicy;
  vaultAdapter: PullEntryStateVaultAdapter;
  eventGate?: SyncEventGateLike;
  blobClient: Pick<SyncBlobClient, "downloadBlob">;
  isDeviceFileExcluded?: (path: string) => boolean;
  shouldApplyRemotePath?: (path: string, deleted: boolean) => boolean;
  shouldUseLatestRemoteVersion?: (path: string) => boolean;
  prepareConcurrency?: number;
  onConflict?: (event: PullConflictEvent) => void;
  onRollbackDetected?: (event: PullRollbackEvent) => void;
  onFileSyncStarted?: (event: {
    operation: "upsert" | "delete";
    path: string;
  }) => void;
  onFileSyncCompleted?: (event: {
    operation: "upsert" | "delete";
    path: string;
    revision: number;
  }) => void;
  onFileSyncFailed?: (event: {
    operation: "upsert" | "delete";
    path: string;
    reason: string;
  }) => void;
  now?: () => number;
}

export interface PullEntryStateApplyResult {
  entriesApplied: number;
  filesWritten: number;
  filesDeleted: number;
  conflictsCreated: number;
}

export type { PullConflictEvent, PullEntryStateManifestItem, PullRollbackEvent };

export type PullEntryStateVaultAdapter = SyncVaultAccess;

export interface PullEntryStateStore
  extends PullManifestStore, SyncEventRecorderStore,
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
  completedStates: Array<{ entryId: string; revision: number }>;
  deferred: PullEntryStateManifestItem[];
};

interface PullWindowOptions {
  finalWindow: boolean;
  selection?: Pick<DeviceFileSelection, "hasMovedFrom" | "hasDeferred">;
  checkSelection?: () => void;
}

export class PullEntryStateApplier {
  private readonly blobPreparer: PullBlobPreparer;
  private readonly manifestPlanner: PullManifestPlanner;
  private readonly pendingMutations: PullPendingMutationHandler;
  private readonly localFiles: PullLocalFileSnapshots;

  constructor(private readonly deps: PullEntryStateApplierDeps) {
    this.blobPreparer = new PullBlobPreparer(deps);
    this.manifestPlanner = new PullManifestPlanner(deps);
    this.pendingMutations = new PullPendingMutationHandler(deps);
    this.localFiles = new PullLocalFileSnapshots(deps);
  }

  async createManifestItems(
    states: RemoteEntryState[],
  ): Promise<PullEntryStateManifestItem[]> {
    const remoteVaultKey = this.deps.getRemoteVaultKey();

    // Settle every metadata worker before returning a failed prefetched page.
    const results = await mapWithConcurrency(
      states,
      this.deps.prepareConcurrency ?? DEFAULT_PREPARE_CONCURRENCY,
      async (state) => {
        try {
          return {
            ok: true as const,
            item: {
              state,
              metadata: await decryptSyncMetadata(
                remoteVaultKey,
                state.encryptedMetadata,
                metadataContextFromRemoteState(state),
              ),
            },
          };
        } catch (error) {
          return { ok: false as const, error };
        }
      },
    );
    return results.map((result) => {
      if (!result.ok) throw result.error;
      return result.item;
    });
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
    options: PullWindowOptions,
  ): Promise<PullEntryStateWindowApplyResult> {
    if (manifest.length === 0) {
      return {
        entriesApplied: 0,
        filesWritten: 0,
        filesDeleted: 0,
        conflictsCreated: 0,
        deferred: [],
        completedStates: [],
      };
    }

    const completed = new Set<string>();
    const totals = { entriesApplied: 0, filesWritten: 0, filesDeleted: 0, conflictsCreated: 0 };
    const deferred = await retrySyncStateWork(async () => {
      const snapshot = syncStateCoordinator(store).watch();
      try {
        return await this.applyManifestWindowAttempt(store, token, manifest, options, snapshot, completed, totals);
      } finally {
        snapshot.dispose();
      }
    });
    return {
      ...totals,
      deferred,
      completedStates: manifest.filter((item) => completed.has(item.state.entryId)).map(({ state }) => ({
        entryId: state.entryId, revision: state.revision,
      })),
    };
  }

  private async applyManifestWindowAttempt(
    store: PullEntryStateStore,
    token: SyncTokenResponse,
    manifest: PullEntryStateManifestItem[],
    options: PullWindowOptions,
    snapshot: SyncStateSnapshot,
    completed: Set<string>,
    totals: PullEntryStateApplyResult,
  ): Promise<PullEntryStateManifestItem[]> {
    const { plans, deferred, superseded, skipped } = await this.manifestPlanner.planManifest(
      store, manifest, { deferExternalPathOwners: !options.finalWindow, appliedEntryIds: completed, selection: options.selection },
    );
    await this.markAlreadyCurrentVaultWrites(store, plans);
    const withExistingPaths = async (items: PullEntryStateManifestItem[]) =>
      await Promise.all(items.map(async (item) => ({
        item, existingPath: (await store.getEntryById(item.state.entryId))?.path ?? null,
      })));
    const [supersededWithPaths, skippedWithPaths] = await Promise.all([
      withExistingPaths(superseded), withExistingPaths(skipped),
    ]);
    const groups: Array<{
      prepared: PreparedManifestApplication;
      estimate: number;
      resources: SyncStateResources;
      pathsToSnapshot: string[];
      localFiles: Map<string, string | null>;
      reservation?: ContentReservation;
    }> = [];
    for (const group of groupPullApplications(plans, supersededWithPaths, skippedWithPaths)) {
      let estimate = 0;
      const supersededPathsToRemove = await this.findSupersededPathsToRemove(store, group.superseded, plans);
      const pathsToSnapshot = uniqueSyncPaths([
        ...group.plans.flatMap(pullPlanFilePaths), ...supersededPathsToRemove,
      ]);
      for (const plan of group.plans) {
        const size = plan.state.blobSize;
        if (size != null && (!Number.isSafeInteger(size) || size < 0)) {
          throw new Error(`Entry state ${plan.state.entryId} has an invalid blob size.`);
        }
        if (!plan.state.deleted && !plan.skipVaultWrite) estimate += (size ?? 0) * 3;
      }
      for (const path of pathsToSnapshot) {
        if (await this.deps.vaultAdapter.exists(path)) {
          estimate += (await this.deps.vaultAdapter.getFileSize(path)) * 8;
        }
      }
      groups.push({
        estimate,
        resources: group.resources,
        pathsToSnapshot,
        localFiles: new Map(),
        prepared: {
          plans: group.plans,
          superseded: group.superseded,
          skipped: group.skipped,
          supersededPathsToRemove,
          pathsToWrite: uniqueSyncPaths(group.plans.filter((plan) => !plan.skipVaultWrite).map((plan) => plan.finalPath)),
          completedStates: [], deferred: [], pendingConflicts: [], batches: [],
        },
      });
    }
    await runPullPreparationPipeline({
      groups,
      concurrency: this.deps.prepareConcurrency ?? DEFAULT_PREPARE_CONCURRENCY,
      runtime: this.deps.contentRuntime,
      estimatedBytes: (group) => group.estimate,
      prepare: async (group, reservation) => {
        const { prepared } = group;
        group.reservation = reservation;
        try {
          options.checkSelection?.();
          group.localFiles = await this.localFiles.capture(group.pathsToSnapshot, reservation);
          // An edit to a retained file can reach disk before its watcher runs.
          // Record it before a returning entry or a replacement takes the path.
          const retainedPaths = new Set<string>();
          for (const plan of prepared.plans) {
            if (plan.finalPath && options.selection?.hasDeferred(plan.state.entryId)) {
              retainedPaths.add(plan.finalPath);
            }
            for (const owner of [plan.existing, plan.supersededPathOwner]) {
              if (owner?.path && !owner.deleted && options.selection?.hasDeferred(owner.entryId)) {
                retainedPaths.add(owner.path);
              }
            }
          }
          const unrecorded: string[] = [];
          for (const path of retainedPaths) {
            const diskHash = group.localFiles.get(path);
            if (diskHash === undefined) continue;
            const local = await store.getLocalStateByPath(path);
            if (diskHash !== (local?.hash ?? null)) unrecorded.push(path);
          }
          if (unrecorded.length) {
            await this.localFiles.recordChanges(store, unrecorded, reservation);
            throw new PullLocalFilesChangedError(unrecorded);
          }
          await this.prepareApplicationGroup(store, token, prepared, reservation, options.checkSelection);
          for (const conflict of prepared.pendingConflicts) {
            const path = conflict.event?.conflictPath;
            // Conflict copies were allocated only after checking nonexistence.
            if (path && !group.localFiles.has(path)) group.localFiles.set(path, null);
          }
          // Pending deletes can refer to an entry with no visible local path.
          group.resources.entryIds = [...(group.resources.entryIds ?? []),
            ...prepared.pendingConflicts.map((conflict) => conflict.pending.entryId)];
          group.resources.paths = [...(group.resources.paths ?? []),
            ...prepared.pendingConflicts.flatMap((conflict) => [conflict.event?.originalPath, conflict.event?.conflictPath])];
        } catch (error) {
          for (const plan of prepared.plans) {
            this.deps.onFileSyncFailed?.({
              operation: plan.state.deleted ? "delete" : "upsert",
              path: plan.metadata.path ?? "<unavailable>", reason: "prepare_failed",
            });
          }
          throw error;
        }
      },
      apply: async ({ prepared, resources, localFiles, reservation }) => {
        try {
          await withSyncState(store, resources, async () => {
            const current = await this.localFiles.capture([...localFiles.keys()], reservation!);
            const changedPaths = [...localFiles].filter(([path, hash]) => current.get(path) !== hash).map(([path]) => path);
            if (changedPaths.length > 0) throw new PullLocalFilesChangedError(changedPaths);
            totals.filesDeleted += await this.applyPreparedManifest(store, prepared, options.checkSelection);
            totals.entriesApplied += prepared.plans.length + prepared.superseded.length;
            totals.filesWritten += prepared.pathsToWrite.length;
            totals.conflictsCreated += prepared.plans.filter((plan) => plan.pathConflict?.conflictPath).length
              + prepared.pendingConflicts.filter((conflict) => conflict.event?.conflictPath).length;
            for (const item of [...prepared.plans, ...prepared.superseded, ...prepared.skipped]) {
              completed.add(item.state.entryId);
            }
          }, snapshot);
        } catch (error) {
          if (error instanceof PullLocalFilesChangedError) {
            await this.localFiles.recordChanges(store, error.paths, reservation!);
          }
          throw error;
        }
      },
      clear: ({ prepared }) => {
        prepared.batches.length = 0;
        prepared.pendingConflicts.length = 0;
      },
    });
    return deferred;
  }

  private async prepareApplicationGroup(
    store: PullEntryStateStore,
    token: SyncTokenResponse,
    prepared: PreparedManifestApplication,
    reservation: ContentReservation,
    checkSelection?: () => void,
  ): Promise<void> {
    const blobs = await this.blobPreparer.preparePathBatchBlobs(store, token, prepared.plans, reservation, checkSelection);
    prepared.batches.push({
      plans: prepared.plans,
      pathsToRemove: uniqueSyncPaths(prepared.plans.flatMap(pathsToRemoveForPlan)),
      blobs,
    });
    const blobByPlan = new Map(blobs.map((blob) => [blob.plan, blob]));
    const pendingIds = new Set<string>();
    for (const plan of prepared.plans) {
      const conflicts = await this.pendingMutations.prepareConflictingPendingMutations(
        store, plan, blobByPlan.get(plan) ?? null, reservation,
      );
      for (const conflict of conflicts) {
        if (pendingIds.has(conflict.pending.mutationId)) continue;
        pendingIds.add(conflict.pending.mutationId);
        prepared.pendingConflicts.push(conflict);
      }
    }
  }

  private async applySkippedRemoteStates(
    store: PullEntryStateStore,
    skipped: PullEntryStateManifestItem[],
  ): Promise<void> {
    for (const plan of skipped) {
      const local = await store.getLocalStateById(plan.state.entryId);
      if (local?.path && await this.deps.vaultAdapter.isExcludedPath?.(local.path)) {
        await store.clearLocalState(plan.state.entryId);
      }
      await store.applyRemoteState({
        entryId: plan.state.entryId,
        path: plan.metadata.path,
        revision: plan.state.revision,
        blobId: plan.state.deleted ? null : plan.state.blobId,
        hash: plan.metadata.hash,
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
    checkSelection?: () => void,
  ): Promise<number> {
    const snapshot = await capturePullStoreSnapshot(store, prepared);
    checkSelection?.();
    const pendingConflictsByPlan = groupPendingConflictsByPlan(prepared.pendingConflicts);
    const fileEvents = prepared.plans.map((plan) => ({
      operation: plan.state.deleted ? "delete" as const : "upsert" as const,
      path: plan.finalPath ?? plan.metadata.path ?? "<unavailable>",
      revision: plan.state.revision,
    }));
    for (const event of fileEvents) {
      this.deps.onFileSyncStarted?.({
        operation: event.operation,
        path: event.path,
      });
    }

    try {
      let filesDeleted = 0;
      filesDeleted = await this.runWithSuppressedPaths(
        [
          ...prepared.supersededPathsToRemove,
          ...prepared.batches.flatMap((batch) => batch.pathsToRemove),
          ...prepared.batches.flatMap((batch) =>
            batch.plans.flatMap((plan) => [plan.vaultMove?.from, plan.vaultMove?.to]),
          ),
          ...prepared.pathsToWrite,
        ],
        async () => {
          let removedTotal = 0;
          // Materialize local conflict copies before releasing their owner's
          // path or dirty record, including when the process exits mid-apply.
          for (const conflict of prepared.pendingConflicts) {
            await this.pendingMutations.applyPreparedPendingConflict(store, conflict);
          }
          await this.applySkippedRemoteStates(store, prepared.skipped);
          await this.applySupersededRemoteEntries(store, prepared);
          for (const path of prepared.supersededPathsToRemove) {
            if (await removeVaultPathIfExists(this.deps.vaultAdapter, path)) {
              removedTotal += 1;
            }
          }
          for (const batch of prepared.batches) {
            const batchPendingConflicts = uniquePendingConflicts(
              batch.plans.flatMap((plan) => pendingConflictsByPlan.get(plan) ?? []),
            );
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

            for (const { plan, bytes, transfer } of batch.blobs) {
              if (!plan.finalPath || plan.skipVaultWrite) {
                continue;
              }
              const path = plan.finalPath;
              await transfer.run("write", () => writeVaultBytes(this.deps.vaultAdapter, path, bytes));
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
          }

          return removedTotal;
        },
      );

      for (const plan of prepared.plans) {
        if (plan.pathConflict) this.deps.onConflict?.(plan.pathConflict);
      }
      for (const event of fileEvents) {
        this.deps.onFileSyncCompleted?.(event);
      }
      return filesDeleted;
    } catch (error) {
      for (const event of fileEvents) {
        this.deps.onFileSyncFailed?.({
          operation: event.operation,
          path: event.path,
          reason: "apply_failed",
        });
      }
      await snapshot.restore();
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

  private async applySupersededRemoteEntries(
    store: PullEntryStateStore,
    prepared: PreparedManifestApplication,
  ): Promise<void> {
    const incomingByEntryId = new Map(
      prepared.superseded.map((entry) => [entry.state.entryId, entry]),
    );
    const entryIds = new Set(incomingByEntryId.keys());
    for (const plan of prepared.plans) {
      if (plan.supersededPathOwner) {
        entryIds.add(plan.supersededPathOwner.entryId);
      }
    }

    for (const entryId of entryIds) {
      const pending = await store.getDirtyEntryMutation(entryId);
      if (pending) {
        await store.clearDirtyEntryByMutationId(pending.mutationId);
      }
      await store.clearLocalState(entryId);

      const incoming = incomingByEntryId.get(entryId);
      if (incoming) {
        await store.applyRemoteState({
          entryId,
          path: incoming.state.deleted ? incoming.metadata.path : null,
          revision: incoming.state.revision,
          blobId: incoming.state.deleted ? null : incoming.state.blobId,
          hash: incoming.state.deleted ? null : incoming.metadata.hash,
          deleted: incoming.state.deleted,
          updatedAt: incoming.state.updatedAt,
        });
        continue;
      }

      const remote = await store.getRemoteStateById(entryId);
      if (remote) {
        await store.applyRemoteState({ ...remote, path: remote.deleted ? remote.path : null });
      }
    }
  }

  private async findSupersededPathsToRemove(
    store: PullEntryStateStore,
    superseded: PullEntryStateManifestItem[],
    plans: PlannedEntryState[],
  ): Promise<string[]> {
    const claimedPaths = new Set(
      plans.map((plan) => plan.finalPath).filter((path): path is string => !!path),
    );
    const paths: Array<string | null> = [];
    for (const item of superseded) {
      const existing = await store.getEntryById(item.state.entryId);
      if (existing?.path && !existing.deleted && !claimedPaths.has(existing.path) &&
          !this.deps.isDeviceFileExcluded?.(existing.path)) {
        paths.push(existing.path);
      }
    }
    return uniqueSyncPaths(paths);
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
