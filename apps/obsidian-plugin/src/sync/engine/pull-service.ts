import type { SyncTokenResponse } from "../remote/client";
import type { SyncEventGateLike } from "./event-gate";
import { SyncPullClient } from "../remote/pull-client";
import type { SyncRealtimeSession } from "../remote/realtime-client";
import type {
  SyncCursorStore,
  SyncStoreLifecycle,
} from "../store/ports";
import type { SyncProgressCounts } from "../store/store";
import {
  type PullConflictEvent,
  PullEntryStateApplier,
  type PullEntryStateStore,
  type PullEntryStateManifestItem,
  type PullEntryStateVaultAdapter,
} from "./pull-entry-state-applier";

const DEFAULT_PULL_BATCH = 50;
const DEFAULT_PULL_APPLY_WINDOW = 200;
const DEFAULT_PULL_PREPARE_CONCURRENCY = 10;

export interface SyncPullServiceDeps {
  getApiBaseUrl: () => string;
  getSyncToken: () => Promise<SyncTokenResponse>;
  getSyncStore: () => SyncPullStore | null;
  getRemoteVaultKey: () => Uint8Array;
  shouldApplyRemotePath?: (path: string) => boolean;
  vaultAdapter: PullVaultAdapter;
  eventGate?: SyncEventGateLike;
  pullClient?: Pick<SyncPullClient, "downloadBlob">;
  prepareConcurrency?: number;
  applyWindowSize?: number;
  onProgress: (progress: SyncProgressCounts) => Promise<void>;
  onConflict?: (event: PullConflictEvent) => void;
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
    this.pullClient = deps.pullClient ?? new SyncPullClient();
    this.entryStateApplier = new PullEntryStateApplier({
      getApiBaseUrl: () => this.deps.getApiBaseUrl(),
      getRemoteVaultKey: () => this.deps.getRemoteVaultKey(),
      vaultAdapter: this.deps.vaultAdapter,
      eventGate: this.deps.eventGate,
      pullClient: this.pullClient,
      shouldApplyRemotePath: this.deps.shouldApplyRemotePath,
      prepareConcurrency:
        this.deps.prepareConcurrency ?? DEFAULT_PULL_PREPARE_CONCURRENCY,
      onProgress: async (progress) => {
        await this.deps.onProgress(progress);
      },
      onConflict: this.deps.onConflict,
      now: this.deps.now,
    });
  }

  async pullOnce(session: SyncRealtimeSession): Promise<PullOnceResult> {
    const store = this.deps.getSyncStore();
    if (!store) {
      throw new Error("Sync store is not initialized.");
    }

    const token = await this.deps.getSyncToken();
    const requestCursor = await store.getCursor();
    let cursor = requestCursor;
    let hasMore = true;
    let targetCursor: number | null = null;
    let totalEntries = 0;
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
      totalEntries = page.totalEntries;
      window.push(...(await this.entryStateApplier.createManifestItems(page.entries)));
      after = page.nextAfter;
      hasMore = page.hasMore;

      if (window.length >= applyWindowSize || !hasMore) {
        const appliedWindow = window;
        const applied = await this.entryStateApplier.applyManifestWindow(
          store,
          token,
          window,
          {
            finalWindow: !hasMore,
            progress: {
              completedOffset: totals.entriesApplied,
              totalEntries,
            },
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
          progress: {
            completedOffset: totals.entriesApplied,
            totalEntries,
          },
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
