import { captureDeviceFileRulesVersion } from "./device-file-rules-version";
import { DeviceFileSelection } from "./device-file-selection";
import type { SyncStore } from "../store/store";
import type { SyncDiagnostics } from "../diagnostics/types";
import type { SyncConflictPolicy } from "../core/conflict-policy";
import type { SyncTokenResponse } from "../remote/client";
import type { SyncContentRuntimeDeps } from "../core/content-runtime";
import type { SyncEventGateLike } from "./event-gate";
import type { SyncBlobClient } from "../remote/blob-client";
import type { SyncRealtimeSession } from "../remote/realtime-client";
import type { SyncCursorStore, SyncRemoteEntryStore } from "../store/ports";
import type { SyncOperationProgress } from "../runtime/user-visible-status";
import { SyncWorkProgress } from "./work-progress";
import { loadRecoveryManifest } from "./pull-recovery-manifest";
import type { PullMode } from "./pull-entry-state-internal";
import {
  type PullConflictEvent,
  PullEntryStateApplier,
  type PullEntryStateStore,
  type PullEntryStateManifestItem,
  type PullEntryStateVaultAdapter,
  type PullRollbackEvent,
} from "./pull-entry-state-applier";

const DEFAULT_PULL_BATCH = 100;
const DEFAULT_PULL_APPLY_WINDOW = 100;
// Group preparation is byte-budgeted; retain a separate work/network cap for
// small files and legacy servers that do not advertise encrypted blob sizes.
const DEFAULT_PULL_PREPARE_CONCURRENCY = 10;

export interface SyncPullServiceDeps extends SyncContentRuntimeDeps {
  diagnostics?: SyncDiagnostics;
  getSyncToken: () => Promise<SyncTokenResponse>;
  getSyncStore: () => SyncPullStore | null;
  getRemoteVaultKey: () => Uint8Array;
  getConflictPolicy?: () => SyncConflictPolicy;
  getDeviceFileRulesVersion?: () => number | undefined;
  assertFileRulesScanned?: () => void;
  isDeviceFileExcluded?: (path: string) => boolean;
  shouldApplyRemotePath?: (path: string, deleted: boolean) => boolean;
  shouldUseLatestRemoteVersion?: (path: string) => boolean;
  vaultAdapter: PullVaultAdapter;
  eventGate?: SyncEventGateLike;
  blobClient: Pick<SyncBlobClient, "downloadBlob">;
  prepareConcurrency?: number;
  applyWindowSize?: number;
  onProgress?: (progress: SyncOperationProgress) => Promise<void>;
  onConflict?: (event: PullConflictEvent) => void;
  onRollbackDetected?: (event: PullRollbackEvent) => void;
  onRemoteStatesChange?: () => void;
  onLocalMutationQueued?: () => void;
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

export interface SyncPullStore extends SyncCursorStore, PullEntryStateStore, Pick<SyncStore, "deferredFiles">,
  Pick<SyncRemoteEntryStore, "listRemoteStates"> {}

export interface PullOnceResult {
  cursor: number;
  entriesApplied: number;
  filesWritten: number;
  filesDeleted: number;
  conflictsCreated: number;
}

export class SyncPullService {
  private checkedSelection?: { store: SyncPullStore; version: number };
  private readonly entryStateApplier: PullEntryStateApplier;

  constructor(private readonly deps: SyncPullServiceDeps) {
    this.entryStateApplier = new PullEntryStateApplier({
      getRemoteVaultKey: () => this.deps.getRemoteVaultKey(),
      vaultAdapter: this.deps.vaultAdapter,
      eventGate: this.deps.eventGate,
      blobClient: this.deps.blobClient,
      diagnostics: this.deps.diagnostics,
      contentRuntime: this.deps.contentRuntime,
      isDeviceFileExcluded: this.deps.isDeviceFileExcluded,
      shouldApplyRemotePath: this.deps.shouldApplyRemotePath,
      shouldUseLatestRemoteVersion: this.deps.shouldUseLatestRemoteVersion,
      getConflictPolicy: this.deps.getConflictPolicy,
      prepareConcurrency:
        this.deps.prepareConcurrency ?? DEFAULT_PULL_PREPARE_CONCURRENCY,
      onLocalMutationQueued: this.deps.onLocalMutationQueued,
      onConflict: this.deps.onConflict,
      onRollbackDetected: this.deps.onRollbackDetected,
      onFileSyncStarted: this.deps.onFileSyncStarted,
      onFileSyncCompleted: this.deps.onFileSyncCompleted,
      onFileSyncFailed: this.deps.onFileSyncFailed,
      now: this.deps.now,
    });
  }

  async recoverPendingWrites(): Promise<void> {
    const store = this.deps.getSyncStore();
    if (store) await this.entryStateApplier.writeRecovery.recover(store);
  }

  /** Reconcile stale entries without rewinding or advancing the global cursor. */
  async recoverEntryStates(
    session: SyncRealtimeSession,
    entryIds: string[],
    onProgress = this.deps.onProgress ?? (async (_progress: SyncOperationProgress) => {}),
  ): Promise<void> {
    if (entryIds.length === 0) return;
    const store = this.deps.getSyncStore();
    if (!store) throw new Error("Sync store is not initialized.");
    const { assertCurrent: checkSelection } = this.captureFileRules();
    await this.entryStateApplier.writeRecovery.recover(store);
    const token = await this.deps.getSyncToken();
    const progress = new SyncWorkProgress("pull");
    await onProgress(progress.snapshot());
    const selection = await this.loadFileSelection(store, false);
    const manifest = await this.loadRecovery(session, store, entryIds, async (items) => {
      progress.register(items.map(manifestKey));
      await onProgress(progress.snapshot());
    });
    progress.seal();
    await onProgress(progress.snapshot());
    try {
      // Resolve ownership across the whole recovery snapshot, including owners
      // fetched in later batches. Blob preparation remains byte-budgeted.
      checkSelection();
      const applied = await selection.applyWindow(manifest, (items) =>
        this.entryStateApplier.applyManifestWindow(store, token, items, { finalWindow: true, selection, checkSelection }));
      progress.complete(applied.completedStates.map(stateKey));
      progress.complete(manifest.filter((item) => item.contextOnly).map(manifestKey));
      await onProgress(progress.snapshot());
    } finally {
      if (manifest.length > 0) this.deps.onRemoteStatesChange?.();
    }
  }

  async pullOnce(
    session: SyncRealtimeSession,
    onProgress = this.deps.onProgress ?? (async (_progress: SyncOperationProgress) => {}),
    mode: PullMode = "bidirectional",
  ): Promise<PullOnceResult> {
    const store = this.deps.getSyncStore();
    if (!store) {
      throw new Error("Sync store is not initialized.");
    }

    const { version, assertCurrent: checkSelection } = this.captureFileRules(mode);
    if (mode !== "read-only") await this.entryStateApplier.writeRecovery.recover(store);
    const token = await this.deps.getSyncToken();
    let cursor = await store.getCursor();
    // Excluded paths keep remote metadata without claiming it was applied.
    // When a path becomes available, replay a fresh authenticated snapshot;
    // never reset the persisted checkpoint or apply stale cached remote data.
    const selection = await this.loadFileSelection(store, !this.alreadyChecked(store, version));
    const recovering = selection.newlyIncluded.size > 0;
    const requestCursor = await this.needsExcludedPathReplay(store) ? 0 : cursor;
    let hasMore = true;
    let targetCursor: number | null = null;
    const progress = new SyncWorkProgress("pull");
    const received = new Set<string>();
    await onProgress(progress.snapshot());
    let window: PullEntryStateManifestItem[] = [];
    const applyWindowSize = normalizePositiveInteger(
      this.deps.applyWindowSize,
      DEFAULT_PULL_APPLY_WINDOW,
    );
    const totals = {
      entriesApplied: 0,
      filesWritten: 0,
      filesDeleted: 0,
      conflictsCreated: 0,
    };

    const preparePage = async (
      target: number | null,
      after: { updatedSeq: number; entryId: string } | null,
    ) => {
      const page = await session.listEntryStates({
        sinceCursor: requestCursor,
        targetCursor: target,
        after,
        limit: DEFAULT_PULL_BATCH,
      });
      const entries = page.entries.filter((entry) => {
        const key = stateKey(entry);
        if (received.has(key)) return false;
        received.add(key);
        return true;
      });
      const items = await this.entryStateApplier.createManifestItems(entries);
      return { page, items };
    };
    // Observe errors immediately, but propagate them only when consuming the page.
    const startPage = (
      target: number | null,
      after: { updatedSeq: number; entryId: string } | null,
    ) => preparePage(target, after).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let pendingPage = startPage(null, null);
    let remoteStatesMayHaveChanged = false;

    try {
      while (hasMore) {
        const result = await pendingPage;
        if (!result.ok) throw result.error;
        const { page, items } = result.value;
        checkSelection();
        if (recovering && targetCursor !== null && targetCursor !== page.targetCursor) {
          throw new Error("Entry-state pagination changed its target cursor.");
        }
        targetCursor = page.targetCursor;
        hasMore = page.hasMore;
        // Only metadata is prefetched. Planning, vault writes and checkpoints stay
        // ordered, and at most one page is prepared ahead of the current window.
        if (hasMore) pendingPage = startPage(targetCursor, page.nextAfter);
        progress.register(items.map(manifestKey));
        window.push(...items);
        if (recovering && !hasMore) {
          window = await this.includeDeferredFiles(session, store, window, selection.newlyIncluded, targetCursor, progress);
        }
        if (!hasMore) progress.seal();
        await onProgress(progress.snapshot());

        if (window.length && ((!recovering && window.length >= applyWindowSize) || !hasMore)) {
          checkSelection();
          const appliedWindow = window;
          remoteStatesMayHaveChanged = true;
          const applied = await selection.applyWindow(window, (items) =>
            this.entryStateApplier.applyManifestWindow(store, token, items, {
              finalWindow: !hasMore, selection, checkSelection, mode,
            }));
          totals.entriesApplied += applied.entriesApplied;
          totals.filesWritten += applied.filesWritten;
          totals.filesDeleted += applied.filesDeleted;
          totals.conflictsCreated += applied.conflictsCreated;
          window = applied.deferred;
          cursor = await this.checkpointAppliedWindow(
            store,
            cursor,
            appliedWindow,
            applied.deferred,
            hasMore ? null : targetCursor,
          );
          progress.complete(applied.completedStates.map(stateKey));
          progress.complete(appliedWindow.filter((item) => item.contextOnly).map(manifestKey));
          await onProgress(progress.snapshot());
        }
      }
    } finally {
      // Do not let background work outlive pullOnce (or its crypto/session).
      await pendingPage;
      // Refresh host warnings once per pull, including skipped remote files and
      // partial progress before a later failure. Empty polls need no refresh.
      if (remoteStatesMayHaveChanged) this.deps.onRemoteStatesChange?.();
    }

    checkSelection();
    if (version !== undefined && !selection.newlyIncluded.size) this.checkedSelection = { store, version };

    cursor = targetCursor ?? cursor;
    if (cursor > await store.getCursor()) {
      await store.setCursor(cursor);
    }

    return {
      cursor,
      entriesApplied: totals.entriesApplied,
      filesWritten: totals.filesWritten,
      filesDeleted: totals.filesDeleted,
      conflictsCreated: totals.conflictsCreated,
    };
  }

  /** An old tombstone or move can release a path claimed in the new delta. */
  private async includeDeferredFiles(
    session: SyncRealtimeSession,
    store: SyncPullStore,
    delta: PullEntryStateManifestItem[],
    newlyIncluded: ReadonlySet<string>,
    targetCursor: number,
    progress: SyncWorkProgress,
  ): Promise<PullEntryStateManifestItem[]> {
    const byId = new Map(delta.map((item) => [item.state.entryId, item]));
    const missing = [...newlyIncluded].filter((id) => !byId.has(id));
    if (!missing.length) return delta;
    const recovered = await this.loadRecovery(session, store, missing, async (items) => {
      progress.register(items.map(manifestKey));
    }, targetCursor);
    for (const item of recovered) {
      if (!byId.has(item.state.entryId)) byId.set(item.state.entryId, item);
    }
    if (missing.some((id) => !byId.has(id))) {
      throw new Error("A deferred file changed during recovery. Retry with a fresh snapshot.");
    }
    return [...byId.values()].sort((a, b) => a.state.updatedSeq - b.state.updatedSeq);
  }

  private loadRecovery(
    session: SyncRealtimeSession,
    store: SyncPullStore,
    ids: string[],
    onItems: (items: PullEntryStateManifestItem[]) => Promise<void>,
    targetCursor?: number,
  ) {
    return loadRecoveryManifest(session, store, ids, {
      applier: this.entryStateApplier, targetCursor, onItems,
      shouldApplyRemotePath: (path, deleted) => !this.deps.isDeviceFileExcluded?.(path) &&
        this.deps.shouldApplyRemotePath?.(path, deleted) !== false,
    });
  }

  private async checkpointAppliedWindow(
    store: SyncPullStore,
    currentCursor: number,
    window: PullEntryStateManifestItem[],
    deferred: PullEntryStateManifestItem[],
    finalTargetCursor: number | null,
  ): Promise<number> {
    const safeCursor = getSafeCheckpointCursor(
      currentCursor,
      window,
      deferred,
      finalTargetCursor,
    );
    if (safeCursor <= currentCursor) {
      return currentCursor;
    }

    await store.setCursor(safeCursor);
    return safeCursor;
  }

  private loadFileSelection(store: SyncPullStore, scanForInclusions = true): Promise<DeviceFileSelection> {
    return DeviceFileSelection.load(store, this.deps.isDeviceFileExcluded, this.deps.onRollbackDetected, scanForInclusions);
  }

  async hasNewlyIncludedFiles(): Promise<boolean> {
    const store = this.deps.getSyncStore();
    if (!store) return false;
    const version = this.deps.getDeviceFileRulesVersion?.();
    if (this.alreadyChecked(store, version)) return false;
    const hasFiles = (await this.loadFileSelection(store)).newlyIncluded.size > 0;
    if (version !== undefined && !hasFiles) this.checkedSelection = { store, version };
    return hasFiles;
  }

  private alreadyChecked(store: SyncPullStore, version: number | undefined): boolean {
    return version !== undefined && this.checkedSelection?.store === store && this.checkedSelection.version === version;
  }

  private captureFileRules(mode: PullMode = "bidirectional") {
    if (mode !== "read-only") this.deps.assertFileRulesScanned?.();
    return captureDeviceFileRulesVersion(() => this.deps.getDeviceFileRulesVersion?.());
  }

  private async needsExcludedPathReplay(store: SyncPullStore): Promise<boolean> {
    if (!this.deps.vaultAdapter.isExcludedPath) return false;
    for (const remote of await store.listRemoteStates()) {
      if (!remote.path ||
          this.deps.shouldApplyRemotePath?.(remote.path, remote.deleted) === false ||
          await store.getDirtyEntryMutation(remote.entryId)) continue;
      const local = await store.getLocalStateById(remote.entryId);
      if (local && local.deleted === remote.deleted && local.blobId === remote.blobId &&
          local.hash === remote.hash && (local.path === remote.path ||
          (local.path && await this.deps.vaultAdapter.areSameFilePaths?.(local.path, remote.path)))) continue;
      if (!await this.deps.vaultAdapter.isExcludedPath(remote.path)) return true;
    }
    return false;
  }
}

export type PullVaultAdapter = PullEntryStateVaultAdapter;

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.floor(value));
}

function getSafeCheckpointCursor(
  currentCursor: number,
  window: PullEntryStateManifestItem[],
  deferred: PullEntryStateManifestItem[],
  finalTargetCursor: number | null,
): number {
  if (deferred.length > 0) {
    const firstDeferredCursor = Math.min(
      ...deferred.map((item) => item.state.updatedSeq),
    );
    return Math.max(currentCursor, firstDeferredCursor - 1);
  }

  if (finalTargetCursor !== null) {
    return Math.max(currentCursor, finalTargetCursor);
  }

  const lastAppliedCursor = Math.max(
    currentCursor,
    ...window.map((item) => item.state.updatedSeq),
  );
  return lastAppliedCursor;
}

function manifestKey(item: PullEntryStateManifestItem): string {
  return stateKey(item.state);
}

function stateKey(state: { entryId: string; revision: number }): string {
  return JSON.stringify([state.entryId, state.revision]);
}
