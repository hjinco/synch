import type { SyncTokenResponse } from "../remote/client";
import type { SyncContentRuntimeDeps } from "../core/content-runtime";
import type { SyncEventGateLike } from "./event-gate";
import { SyncPullClient } from "../remote/pull-client";
import type { SyncRealtimeSession } from "../remote/realtime-client";
import type {
  SyncCursorStore,
  SyncStoreLifecycle,
} from "../store/ports";
import type { SyncOperationProgress } from "../runtime/user-visible-status";
import { SyncWorkProgress } from "./work-progress";
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
const DEFAULT_PULL_PREPARE_CONCURRENCY = 10;

export interface SyncPullServiceDeps extends SyncContentRuntimeDeps {
  getApiBaseUrl: () => string;
  getSyncToken: () => Promise<SyncTokenResponse>;
  getSyncStore: () => SyncPullStore | null;
  getRemoteVaultKey: () => Uint8Array;
  shouldApplyRemotePath?: (path: string) => boolean;
  shouldUseLatestRemoteVersion?: (path: string) => boolean;
  vaultAdapter: PullVaultAdapter;
  eventGate?: SyncEventGateLike;
  pullClient: Pick<SyncPullClient, "downloadBlob">;
  prepareConcurrency?: number;
  applyWindowSize?: number;
  onProgress?: (progress: SyncOperationProgress) => Promise<void>;
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

export interface SyncPullStore
  extends SyncCursorStore,
    Pick<SyncStoreLifecycle, "flush">,
    PullEntryStateStore {}

export interface PullOnceResult {
  cursor: number;
  entriesApplied: number;
  filesWritten: number;
  filesDeleted: number;
  conflictsCreated: number;
}

export class SyncPullService {
  private readonly pullClient: Pick<SyncPullClient, "downloadBlob">;
  private readonly entryStateApplier: PullEntryStateApplier;

  constructor(private readonly deps: SyncPullServiceDeps) {
    this.pullClient = deps.pullClient;
    this.entryStateApplier = new PullEntryStateApplier({
      getApiBaseUrl: () => this.deps.getApiBaseUrl(),
      getRemoteVaultKey: () => this.deps.getRemoteVaultKey(),
      vaultAdapter: this.deps.vaultAdapter,
      eventGate: this.deps.eventGate,
      pullClient: this.pullClient,
      contentRuntime: this.deps.contentRuntime,
      shouldApplyRemotePath: this.deps.shouldApplyRemotePath,
      shouldUseLatestRemoteVersion: this.deps.shouldUseLatestRemoteVersion,
      prepareConcurrency:
        this.deps.prepareConcurrency ?? DEFAULT_PULL_PREPARE_CONCURRENCY,
      onConflict: this.deps.onConflict,
      onRollbackDetected: this.deps.onRollbackDetected,
      onFileSyncStarted: this.deps.onFileSyncStarted,
      onFileSyncCompleted: this.deps.onFileSyncCompleted,
      onFileSyncFailed: this.deps.onFileSyncFailed,
      now: this.deps.now,
    });
  }

  async pullOnce(
    session: SyncRealtimeSession,
    onProgress = this.deps.onProgress ?? (async (_progress: SyncOperationProgress) => {}),
  ): Promise<PullOnceResult> {
    const store = this.deps.getSyncStore();
    if (!store) {
      throw new Error("Sync store is not initialized.");
    }

    const token = await this.deps.getSyncToken();
    const requestCursor = await store.getCursor();
    let cursor = requestCursor;
    let hasMore = true;
    let targetCursor: number | null = null;
    const progress = new SyncWorkProgress("pull");
    const received = new Set<string>();
    await onProgress(progress.snapshot());
    let after: { updatedSeq: number; entryId: string } | null = null;
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

    while (hasMore) {
      const page = await session.listEntryStates({
        sinceCursor: requestCursor,
        targetCursor,
        after,
        limit: DEFAULT_PULL_BATCH,
      });
      targetCursor = page.targetCursor;
      const entries = page.entries.filter((entry) => {
        const key = stateKey(entry);
        if (received.has(key)) return false;
        received.add(key);
        return true;
      });
      const items = await this.entryStateApplier.createManifestItems(entries);
      progress.register(items.map(manifestKey));
      window.push(...items);
      after = page.nextAfter;
      hasMore = page.hasMore;
      if (!hasMore) progress.seal();
      await onProgress(progress.snapshot());

      if (window.length >= applyWindowSize || !hasMore) {
        const appliedWindow = window;
        const applied = await this.entryStateApplier.applyManifestWindow(
          store,
          token,
          window,
          {
            finalWindow: !hasMore,
          },
        );
        totals.entriesApplied += applied.entriesApplied;
        totals.filesWritten += applied.filesWritten;
        totals.filesDeleted += applied.filesDeleted;
        totals.conflictsCreated += applied.conflictsCreated;
        window = applied.deferred;
        cursor = await this.checkpointAppliedWindow(
          store,
          session,
          cursor,
          appliedWindow,
          applied.deferred,
          hasMore ? null : targetCursor,
        );
        progress.complete(applied.completedStates.map(stateKey));
        await onProgress(progress.snapshot());
      }
    }

    if (window.length > 0) {
      const appliedWindow = window;
      const applied = await this.entryStateApplier.applyManifestWindow(
        store,
        token,
        window,
        {
          finalWindow: true,
        },
      );
      totals.entriesApplied += applied.entriesApplied;
      totals.filesWritten += applied.filesWritten;
      totals.filesDeleted += applied.filesDeleted;
      totals.conflictsCreated += applied.conflictsCreated;
      cursor = await this.checkpointAppliedWindow(
        store,
        session,
        cursor,
        appliedWindow,
        applied.deferred,
        targetCursor,
      );
      progress.complete(applied.completedStates.map(stateKey));
      await onProgress(progress.snapshot());
    }

    cursor = targetCursor ?? cursor;
    if (cursor > await store.getCursor()) {
      await store.setCursor(cursor);
      await store.flush();
    }

    return {
      cursor,
      entriesApplied: totals.entriesApplied,
      filesWritten: totals.filesWritten,
      filesDeleted: totals.filesDeleted,
      conflictsCreated: totals.conflictsCreated,
    };
  }

  private async checkpointAppliedWindow(
    store: SyncPullStore,
    session: SyncRealtimeSession,
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
    await store.flush();
    return safeCursor;
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
