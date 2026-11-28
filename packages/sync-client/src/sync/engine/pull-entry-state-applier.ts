import { commitTextMerge, PullWriteRecovery } from "./pull-text-merge-journal";
import type { TextMergeJournal } from "../store/store";
import type { DeviceFileSelection } from "./device-file-selection";
import type { SyncDiagnostics } from "../diagnostics/types";
import type { SyncEventRecorderStore } from "./event-recorder";
import { PullLocalFileSnapshots, PullLocalFilesChangedError } from "./pull-local-file-snapshots";
import { retrySyncStateWork, SyncStateChangedError, syncStateCoordinator, withSyncState, type SyncStateSnapshot } from "./sync-state-coordinator";
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
  SyncReconcileStore,
} from "../store/ports";
import {
  renameAliasedVaultPath,
  renameVaultPath,
  removeVaultPathIfExists,
  replaceVaultTextIfUnchanged,
  writeVaultBytes,
} from "../vault/vault-writer";
import type { SyncVaultAccess } from "../vault/ports";
import type { SyncEventGateLike } from "./event-gate";
import { groupPullApplications, pullPlanFilePaths, type PreparedManifestApplication } from "./pull-application-groups";
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
  type PullMode,
  type PlannedEntryState,
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
  onLocalMutationQueued?: () => void;
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
    Pick<SyncReconcileStore, "applyReconcileEntryUpdates">,
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
    Pick<SyncBlobStore, "getBlob" | "putBlob"> {
  readonly textMerges: TextMergeJournal;
}

export type PullEntryStateWindowApplyResult = PullEntryStateApplyResult & {
  completedStates: Array<{ entryId: string; revision: number }>;
  deferred: PullEntryStateManifestItem[];
};

interface PullWindowOptions {
  finalWindow: boolean;
  mode?: PullMode;
  selection?: Pick<DeviceFileSelection, "hasMovedFrom">;
  checkSelection?: () => void;
}

export class PullEntryStateApplier {
  readonly writeRecovery: PullWriteRecovery;
  private readonly blobPreparer: PullBlobPreparer;
  private readonly manifestPlanner: PullManifestPlanner;
  private readonly pendingMutations: PullPendingMutationHandler;
  private readonly localFiles: PullLocalFileSnapshots;

  constructor(private readonly deps: PullEntryStateApplierDeps) {
    this.writeRecovery = new PullWriteRecovery(deps);
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
      if (options.mode !== "read-only") await this.writeRecovery.recover(store);
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
    // A replica may have been edited since a partial pull committed this entry
    // but before it checkpointed the window. Reinstall even a replayed version.
    if (options.mode !== "read-only") await this.markAlreadyCurrentVaultWrites(store, plans);
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
      pathsToSnapshot: string[];
      localFiles: Map<string, string | null>;
      needsReplan: boolean;
      reservation?: ContentReservation;
    }> = [];
    for (const group of groupPullApplications(plans, supersededWithPaths, skippedWithPaths)) {
      let estimate = 0;
      const supersededPathsToRemove = await this.findSupersededPathsToRemove(store, group.superseded, plans);
      const pathsToSnapshot = options.mode === "read-only" ? [] : uniqueSyncPaths([
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
        pathsToSnapshot,
        localFiles: new Map(),
        needsReplan: false,
        prepared: {
          ...group,
          supersededPathsToRemove,
          pathsToWrite: uniqueSyncPaths(group.plans.filter((plan) => !plan.skipVaultWrite).map((plan) => plan.finalPath)),
          pendingConflicts: [],
          conflictCopies: [],
          batches: [],
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
          group.needsReplan = await this.localFiles.recordUnobservedEdits(store, prepared.plans, group.localFiles, reservation);
          if (group.needsReplan) return;
          await this.prepareApplicationGroup(store, token, prepared, reservation, options);
          for (const conflict of prepared.conflictCopies) {
            const path = conflict.event?.conflictPath;
            // Conflict copies were allocated only after checking nonexistence.
            if (path && !group.localFiles.has(path)) group.localFiles.set(path, null);
          }
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
      apply: async ({ prepared, localFiles, reservation, needsReplan }) => {
        if (needsReplan) return;
        try {
          await withSyncState(store, prepared.targets.lockResources(), async () => {
            const current = await this.localFiles.capture([...localFiles.keys()], reservation!);
            const changedPaths = [...localFiles].filter(([path, hash]) => current.get(path) !== hash).map(([path]) => path);
            if (changedPaths.length > 0) throw new PullLocalFilesChangedError(changedPaths);
            const applied = await this.applyPreparedManifest(store, prepared, reservation!, current, options.checkSelection);
            totals.filesDeleted += applied.filesDeleted;
            totals.entriesApplied += prepared.plans.length + prepared.superseded.length;
            totals.filesWritten += prepared.pathsToWrite.length;
            totals.conflictsCreated += applied.mergeCopies + prepared.plans.filter((plan) => plan.pathConflict?.conflictPath).length
              + prepared.conflictCopies.filter((conflict) => conflict.event?.conflictPath).length;
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
        prepared.conflictCopies.length = 0;
      },
    });
    // Gather edits from the entire window before spending a retry on replanning.
    if (groups.some((group) => group.needsReplan)) throw new SyncStateChangedError();
    return deferred;
  }

  private async prepareApplicationGroup(
    store: PullEntryStateStore,
    token: SyncTokenResponse,
    prepared: PreparedManifestApplication,
    reservation: ContentReservation,
    options: PullWindowOptions,
  ): Promise<void> {
    const blobs = await this.blobPreparer.preparePathBatchBlobs(store, token, prepared.plans, reservation, options.checkSelection);
    prepared.batches.push({
      plans: prepared.plans,
      pathsToRemove: uniqueSyncPaths(prepared.plans.flatMap(pathsToRemoveForPlan)),
      blobs,
    });
    if (options.mode === "read-only") return;
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
        if (conflict.merge?.kind === "already-present" || conflict.merge?.kind === "keep-source") {
          prepared.pathsToWrite = prepared.pathsToWrite.filter((path) => path !== plan.finalPath);
        }
        if (conflict.event) prepared.conflictCopies.push(conflict);
        prepared.targets.includePendingConflict(conflict);
      }
    }
    // A losing managed destination can still have an edited ordinary source.
    for (const { state } of prepared.superseded) {
      const pending = await store.getDirtyEntryMutation(state.entryId);
      if (!pending || pendingIds.has(pending.mutationId)) continue;
      const conflict = await this.pendingMutations.prepareSupersededConflict(pending, reservation);
      if (conflict) {
        prepared.conflictCopies.push(conflict);
        prepared.targets.includePendingConflict(conflict);
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
          // Removing the old name before the write can unlink its adopted
          // destination when the filesystem treats the two paths as aliases.
          !pathsToRemoveForPlan(plan).some(Boolean) &&
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
    reservation: ContentReservation,
    diskHashes: ReadonlyMap<string, string | null>,
    checkSelection?: () => void,
  ): Promise<{ filesDeleted: number; mergeCopies: number }> {
    const snapshot = await capturePullStoreSnapshot(store, prepared.targets);
    checkSelection?.();
    const pendingConflictsByPlan = groupPendingConflictsByPlan(prepared.pendingConflicts);
    const merges = new Map(prepared.pendingConflicts.flatMap(({ plan, merge }) =>
      merge && merge.kind !== "remote" ? [[plan, merge] as const] : []));
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

    const downloadJournals = new Set<string>();
    const sourceHashes = new Map(diskHashes);
    let filesDeleted: number;
    let mergeCopies = 0;
    try {
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
          for (const conflict of prepared.conflictCopies) {
            await this.pendingMutations.applyPreparedPendingConflict(store, conflict);
          }
          await this.applySkippedRemoteStates(store, prepared.skipped);
          await this.applySupersededRemoteEntries(store, prepared);
          for (const path of prepared.supersededPathsToRemove) {
            if (await removeVaultPathIfExists(this.deps.vaultAdapter, path)) {
              removedTotal += 1;
            }
            sourceHashes.set(path, null);
          }
          for (const batch of prepared.batches) {
            const batchPendingConflicts = uniquePendingConflicts(
              batch.plans.flatMap((plan) => pendingConflictsByPlan.get(plan) ?? []),
            );
            await this.applyAdoptedLocalEntries(store, batch.plans);
            await this.clearChangingStorePaths(store, batch.plans);

            const localPaths = new Map<PlannedEntryState, string>();
            for (const plan of batch.plans) {
              if (plan.vaultMove) {
                const { kind, from, to } = plan.vaultMove;
                if (kind === "alias") {
                  localPaths.set(plan, await renameAliasedVaultPath(this.deps.vaultAdapter, from, to));
                } else {
                  await renameVaultPath(this.deps.vaultAdapter, from, to);
                }
                sourceHashes.set(plan.vaultMove.to, sourceHashes.get(plan.vaultMove.from) ?? null);
                sourceHashes.set(plan.vaultMove.from, null);
              }
            }

            let removed = 0;
            for (const path of batch.pathsToRemove) {
              if (await removeVaultPathIfExists(this.deps.vaultAdapter, path)) {
                removed += 1;
              }
              sourceHashes.set(path, null);
            }

            for (const blob of batch.blobs) {
              const { plan, bytes, transfer } = blob;
              if (!plan.finalPath || plan.skipVaultWrite) {
                continue;
              }
              const path = plan.finalPath;
              const merge = merges.get(plan);
              if (merge?.kind === "keep-source") continue;
              if (merge?.kind === "already-present") {
                const current = await this.localFiles.capture([path], reservation);
                if (current.get(path) !== plan.hash) throw new PullLocalFilesChangedError([path]);
              } else if ((!merge || merge.kind === "remote-text") &&
                  !this.deps.vaultAdapter.atomicWrites && diskHashes.has(path)) {
                // Read-only pulls do not reconcile disk into uploads and have no snapshots.
                const pending = pendingConflictsByPlan.get(plan)?.find(({ pending }) => pending.entryId === plan.state.entryId);
                await this.writeRecovery.downloads.install(
                  store, blob, sourceHashes.get(path) ?? null, pending?.pending.mutationId ?? null,
                  reservation, merge?.sourceText, localPaths.get(plan),
                );
                downloadJournals.add(plan.state.entryId);
              } else if (merge) {
                if (merge.kind === "local") await store.textMerges.put(merge.intent);
                const replacement = merge.kind === "local" ? merge.bytes : bytes;
                const installed = await transfer.run("write", () =>
                  replaceVaultTextIfUnchanged(this.deps.vaultAdapter, path, merge.sourceText, replacement),
                  (written) => written);
                if (!installed) {
                  if (merge.kind === "local") await store.textMerges.remove(plan.state.entryId);
                  throw new PullLocalFilesChangedError([path]);
                }
                if (merge.kind === "local") await store.textMerges.put({ ...merge.intent, installed: true });
              } else {
                await transfer.run("write", () => writeVaultBytes(this.deps.vaultAdapter, path, bytes));
              }
            }

            removedTotal += removed;

            for (const plan of batch.plans) {
              const merge = merges.get(plan);
              if (merge?.kind === "keep-source") {
                await store.textMerges.put(merge.intent);
                if (await this.writeRecovery.preserveMergeBesideSource(store, merge.intent, merge.merged, reservation)) {
                  mergeCopies++;
                }
                continue;
              }
              if (merge?.kind === "local") {
                await commitTextMerge(store, merge.intent);
                continue;
              }
              // Store the remote spelling and the filesystem's local spelling
              // together if a shared parent directory could not be renamed.
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
              }, localPaths.get(plan));
            }
            for (const pendingConflict of batchPendingConflicts) {
              if (pendingConflict.merge && pendingConflict.merge.kind !== "local") {
                await store.clearDirtyEntryByMutationId(pendingConflict.pending.mutationId);
              }
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
    } catch (error) {
      this.writeRecovery.invalidate(store);
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
    try {
      const localMerges = [...merges.values()].filter((merge) => merge.kind === "local" || merge.kind === "keep-source");
      for (const entryId of downloadJournals) await store.textMerges.remove(entryId);
      for (const { intent } of localMerges) await store.textMerges.remove(intent.entryId);
      if (localMerges.length) this.deps.onLocalMutationQueued?.();
    } catch (error) {
      this.writeRecovery.invalidate(store);
      throw error;
    }
    return { filesDeleted, mergeCopies };
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
