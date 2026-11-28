import { DeviceFileRulesChangedError } from "./device-file-selection";
import { isSyncPausedError, isSyncPausedClose } from "../remote/sync-pause";
import type { SyncTokenResponse } from "../remote/client";
import type { PresenceSelection } from "../core/presence";
import {
  isRemoteVaultUnavailableError,
  remoteVaultUnavailableFromWebSocketClose,
  type RemoteVaultUnavailableError,
} from "../../remote-vault/unavailable";
import type { PushPendingMutationsOptions, PushPendingMutationsResult, StalePushMutation } from "./push-service";
import { RecoveryPendingDependenciesError } from "./pull-recovery-manifest";
import {
  type SyncRealtimeClient,
  SyncRealtimeConnectionError,
  SyncRealtimeError,
  type SyncRealtimeSession,
  type SyncStorageStatus,
  type PresenceUpdatedPush,
} from "../remote/realtime-client";
import type { SyncCursorStore, SyncMutationStore } from "../store/ports";
import { SyncAutoLoopState, type SyncConnectionState } from "./auto-sync-state";
import { SyncSessionSubscriptions } from "./auto-sync-subscriptions";
import { AutoSyncTimers } from "./auto-sync-timers";
import { PendingSyncWorkQueue } from "./auto-sync-work-queue";
import { pullWithReadOnlySession } from "./pull-only-session";

const DEFAULT_PUSH_DEBOUNCE_MS = 100;
const DEFAULT_RECONNECT_DELAY_MS = 3_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;
const DEFAULT_SYNC_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_SYNC_RETRY_MAX_DELAY_MS = 30_000;

export interface SyncAutoLoopDeps {
  getApiBaseUrl: () => string;
  getSyncToken: () => Promise<SyncTokenResponse>;
  getSyncStore: () => (SyncCursorStore & SyncMutationStore) | null;
  pushPendingMutations: (
    session: SyncRealtimeSession,
    shouldYield: () => boolean,
    options?: PushPendingMutationsOptions,
  ) => Promise<PushPendingMutationsResult>;
  unblockFileSizeBlockedMutations?: (
    session: SyncRealtimeSession,
  ) => Promise<number>;
  isDeferredEntry?: (id: string) => Promise<boolean>;
  hasNewlyIncludedFiles?: () => Promise<boolean>;
  pullOnce: (session: SyncRealtimeSession) => Promise<unknown>;
  recoverEntryStates?: (session: SyncRealtimeSession, entryIds: string[]) => Promise<void>;
  realtimeClient: SyncRealtimeClientLike;
  pushDebounceMs?: number;
  reconnectDelayMs?: number;
  reconnectMaxDelayMs?: number;
  syncRetryBaseDelayMs?: number;
  syncRetryMaxDelayMs?: number;
  shouldDeferSyncWork?: () => boolean;
  onConnectionStateChange?: (state: SyncConnectionState) => void;
  onStorageStatusChange?: (status: SyncStorageStatus | null) => void;
  onPresenceUpdated?: (update: PresenceUpdatedPush) => void;
  onPresenceCleared?: (presenceId: string) => void;
  onPresenceAvailabilityChanged?: (enabled: boolean) => void;
  onPresenceSessionReset?: () => void;
  onSyncScheduled?: () => void;
  onSyncDeferred?: () => void;
  onIdle?: () => void;
  onRetryScheduled?: (input: { attempt: number; delayMs: number }) => void;
  onError?: (error: unknown) => void;
  onTerminalStop?: (reason: SyncTerminalStopReason) => void;
  onRemoteVaultUnavailable?: (error: RemoteVaultUnavailableError) => void | Promise<void>;
  onStorageQuotaExceeded?: () => void | Promise<void>;
}

export type SyncTerminalStopReason =
  | { type: "sync_paused"; error: Error }
  | { type: "remote_vault_unavailable"; error: RemoteVaultUnavailableError }
  | { type: "sync_history_mismatch"; error: Error }
  | { type: "storage_quota_exceeded" };

export interface SyncRealtimeClientLike {
  openSession: SyncRealtimeClient["openSession"];
}

export class SyncAutoLoop {
  private readonly realtimeClient: SyncRealtimeClientLike;
  private realtimeSession: SyncRealtimeSession | null = null;
  private connectAttempt: { generation: number; promise: Promise<void> } | null = null;
  private connectionGeneration = 0;
  private drainPromise: Promise<void> | null = null;
  private pullOnlyPromise: Promise<void> | null = null;
  private readonly timers = new AutoSyncTimers();
  private reconnectAttempt = 0;
  private syncRetryAttempt = 0;
  private pushPriorityEntryIds: string[] = [];
  private readonly state: SyncAutoLoopState;
  private readonly subscriptions: SyncSessionSubscriptions;
  private readonly pendingWork = new PendingSyncWorkQueue();

  constructor(private readonly deps: SyncAutoLoopDeps) {
    this.realtimeClient = deps.realtimeClient;
    this.state = new SyncAutoLoopState(deps.onConnectionStateChange);
    this.subscriptions = new SyncSessionSubscriptions({
      getSession: () => this.realtimeSession,
      onStorageStatusChange: (status) => this.deps.onStorageStatusChange?.(status),
      onPresenceAvailabilityChanged: (enabled) =>
        this.deps.onPresenceAvailabilityChanged?.(enabled),
      onPresenceSessionReset: () => this.deps.onPresenceSessionReset?.(),
      onError: (error) => this.handleError(error),
    });
  }

  async start(): Promise<boolean> {
    if (this.isActive()) {
      return false;
    }

    this.assertNoPullOnlySession();
    this.state.start();
    await this.ensureRealtimeSession();
    return true;
  }

  stop(): void {
    this.state.stop();
    this.connectionGeneration += 1;
    const session = this.realtimeSession;
    this.realtimeSession = null;
    this.pendingWork.clear();
    this.pushPriorityEntryIds = [];
    this.timers.clearAll();
    this.subscriptions.resetPresence();
    session?.close();
  }

  flushDebouncedPush(): void {
    if (!this.isActive() || !this.timers.has("push")) {
      return;
    }

    this.timers.clear("push");
    this.requestPush();
    this.deps.onSyncScheduled?.();
  }

  async waitForInFlightDrain(): Promise<void> {
    await this.pullOnlyPromise;
    await this.drain();
    while (this.drainPromise) {
      await this.drainPromise;
    }
  }

  hasInFlightWork(): boolean {
    return this.pullOnlyPromise !== null || this.drainPromise !== null || this.timers.has("push");
  }

  notifyLocalChange(): void {
    if (!this.isActive()) {
      return;
    }

    if (this.shouldDeferSyncWork()) {
      this.requestPush();
      this.deps.onSyncDeferred?.();
      return;
    }

    this.deps.onSyncScheduled?.();
    this.timers.set("push", () => {
      this.requestPush();
      void this.drain();
    }, this.deps.pushDebounceMs ?? DEFAULT_PUSH_DEBOUNCE_MS);
  }

  async syncNow(): Promise<boolean> {
    if (!this.isActive()) {
      return false;
    }

    const run = this.state.generation;
    this.timers.clear("push");
    this.deps.onSyncScheduled?.();
    this.requestPullWork(null);
    this.requestPush();
    await this.drain(true);
    return (
      this.state.isCurrent(run) &&
      !this.hasPendingWork() &&
      !this.timers.has("syncRetry") &&
      !this.timers.has("reconnect")
    );
  }

  /**
   * Pull remote changes once without reconciling or uploading local changes.
   *
   * This deliberately uses a short-lived realtime session outside the normal
   * auto-sync drain loop, so pending local mutations are never scheduled for
   * push. It is intended for read-only replicas such as backup hosts.
   */
  async pullOnlyOnce(): Promise<void> {
    this.assertNoPullOnlySession();
    if (this.isActive() || this.connectAttempt || this.drainPromise) {
      throw new Error(
        "Pull-only sync requires the auto-sync loop and all in-flight sync work to be stopped.",
      );
    }

    const running = pullWithReadOnlySession(this.deps);
    this.pullOnlyPromise = running;
    try {
      await running;
    } finally {
      this.pullOnlyPromise = null;
    }
  }

  private assertNoPullOnlySession(): void {
    if (this.pullOnlyPromise) {
      throw new Error("Sync cannot open another session while a pull-only session is running.");
    }
  }

  requestPull(targetCursor: number | null = null): void {
    if (!this.isActive()) {
      return;
    }

    this.requestPullWork(targetCursor);
    if (this.shouldDeferSyncWork()) {
      this.deps.onSyncDeferred?.();
      return;
    }
    this.deps.onSyncScheduled?.();
    void this.drain();
  }

  setStorageStatusWatching(enabled: boolean): void {
    this.subscriptions.setStorageStatusWatching(enabled);
  }

  setPresenceWatching(enabled: boolean): void {
    this.subscriptions.setPresenceWatching(enabled);
  }

  setPresenceWatchEntryIds(entryIds: string[]): void {
    this.subscriptions.setPresenceWatchEntryIds(entryIds);
  }

  updatePresence(entryId: string, selection: PresenceSelection): void {
    this.subscriptions.updatePresence(entryId, selection);
  }

  clearPresence(): void {
    this.subscriptions.clearPresence();
  }

  async ensureRealtimeSession(): Promise<void> {
    const run = this.state.generation;
    while (this.state.isCurrent(run)) {
      // The socket is assigned before initialization finishes. Every caller
      // must join that initialization before treating the session as ready.
      if (!this.connectAttempt && this.realtimeSession) return;
      const attempt = this.connectAttempt ?? {
        generation: this.connectionGeneration,
        promise: this.openRealtimeSession(this.connectionGeneration),
      };
      this.connectAttempt = attempt;
      try {
        await attempt.promise;
      } finally {
        if (this.connectAttempt === attempt) this.connectAttempt = null;
      }
      // A restart can wait for an obsolete attempt, but must then open its own
      // session with fresh credentials. Ordinary failures retain their backoff.
      if (attempt.generation === this.connectionGeneration || this.timers.has("reconnect")) {
        return;
      }
    }
  }

  async withRealtimeSession<T>(
    work: (session: SyncRealtimeSession) => Promise<T>,
  ): Promise<T> {
    this.assertNoPullOnlySession();
    if (!this.isActive()) {
      this.state.start();
    }

    const run = this.state.generation;
    await this.ensureRealtimeSession();
    const session = this.realtimeSession;
    if (!this.state.isCurrent(run) || !session) {
      throw new Error("Sync realtime session is not connected.");
    }

    return await work(session);
  }

  reconnectNow(): void {
    if (!this.isActive()) {
      return;
    }

    this.timers.clear("reconnect");
    this.markRealtimeDisconnected(false);
    void this.ensureRealtimeSession();
  }

  async resumeConnection(): Promise<void> {
    if (!this.isActive()) {
      return;
    }

    this.timers.clear("reconnect");
    await this.ensureRealtimeSession();
  }

  private isCurrentConnection(generation: number): boolean {
    return this.isActive() && generation === this.connectionGeneration;
  }

  private async openRealtimeSession(generation: number): Promise<void> {
    const run = this.state.generation;
    let session: SyncRealtimeSession | null = null;
    try {
      this.state.set("connecting");
      const store = this.deps.getSyncStore();
      if (!store) {
        throw new Error("Sync store is not initialized.");
      }

      const token = await this.deps.getSyncToken();
      if (!this.isCurrentConnection(generation)) return;
      const cursor = await store.getCursor();
      if (!this.isCurrentConnection(generation)) return;
      session = await this.realtimeClient.openSession(
        this.deps.getApiBaseUrl(),
        token,
        cursor,
        {
          onCursorAdvanced: (nextCursor) => {
            if (!this.isCurrentConnection(generation)) return;
            this.requestPull(nextCursor);
          },
          onStorageStatusUpdated: (status) => {
            if (!this.isCurrentConnection(generation)) return;
            this.deps.onStorageStatusChange?.(status);
          },
          onPolicyUpdated: (_policy, storageStatus) => {
            if (!this.isCurrentConnection(generation)) return;
            void this.handlePolicyUpdated(storageStatus, generation);
          },
          onPresenceUpdated: (update) => {
            if (!this.isCurrentConnection(generation)) return;
            this.deps.onPresenceUpdated?.(update);
          },
          onPresenceCleared: (presenceId) => {
            if (!this.isCurrentConnection(generation)) return;
            this.deps.onPresenceCleared?.(presenceId);
          },
          onPresenceAvailabilityChanged: (enabled) => {
            if (!this.isCurrentConnection(generation)) return;
            this.subscriptions.setPresenceAvailability(enabled);
          },
          onClose: (event) => {
            if (!this.isCurrentConnection(generation)) return;
            if (isSyncPausedClose(event)) {
              this.handleError(new SyncRealtimeError("sync_paused", "vault sync is temporarily paused for repair"));
              return;
            }
            const unavailable = remoteVaultUnavailableFromWebSocketClose(
              event,
              token.vaultId,
            );
            if (unavailable) {
              this.handleRemoteVaultUnavailable(unavailable);
              return;
            }

            this.markRealtimeDisconnected();
          },
          onError: (error) => {
            if (!this.isCurrentConnection(generation)) return;
            if (
              !isRealtimeConnectionError(error) &&
              !isCursorAheadOfServerError(error)
            ) {
              this.handleError(error);
            }
          },
        },
      );
      if (!this.isCurrentConnection(generation)) {
        session.close();
        return;
      }

      this.realtimeSession = session;
      if (cursor > session.serverCursor) {
        throw new SyncRealtimeError(
          "cursor_ahead_of_server",
          "Sync was paused because this device's sync history no longer matches the remote vault. To resume syncing, disconnect and reconnect the remote vault in Synch settings.",
        );
      }
      this.reconnectAttempt = 0;
      this.timers.clear("reconnect");
      this.subscriptions.restore(session);
      if (!this.isCurrentConnection(generation)) return;
      await this.unblockFileSizeBlockedMutations(session, run);
      if (!this.isCurrentConnection(generation)) return;
      const needsPull = session.serverCursor > cursor || await this.deps.hasNewlyIncludedFiles?.();
      if (!this.isCurrentConnection(generation)) return;
      if (needsPull) {
        this.requestPullWork(session.serverCursor);
        this.reportQueuedWork();
      }
      this.state.set("live");
      if (this.hasPendingWork() && !this.shouldDeferSyncWork()) {
        void this.drain();
      } else if (!this.hasPendingWork()) {
        this.deps.onIdle?.();
      }
    } catch (error) {
      if (!this.isCurrentConnection(generation)) return;
      // Invalidate callbacks before closing; close may synchronously emit events.
      this.connectionGeneration += 1;
      this.realtimeSession = null;
      if (session) {
        this.subscriptions.disconnect();
        session.close();
      }
      if (isCursorAheadOfServerError(error)) {
        this.stop();
        this.handleError(error);
        this.deps.onTerminalStop?.({ type: "sync_history_mismatch", error });
        return;
      }

      if (isRemoteVaultUnavailableError(error)) {
        this.handleRemoteVaultUnavailable(error);
        return;
      }

      if (!isRealtimeConnectionError(error)) {
        this.handleError(error);
      }
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.isActive() || this.timers.has("reconnect")) {
      return;
    }

    this.state.set("reconnect_wait");
    const baseDelay = this.deps.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    const maxDelay = this.deps.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
    const delay = Math.min(baseDelay * 2 ** this.reconnectAttempt, maxDelay);
    this.reconnectAttempt += 1;
    this.timers.set("reconnect", () => {
      void this.ensureRealtimeSession();
    }, delay);
  }

  private markRealtimeDisconnected(scheduleReconnect = true): void {
    if (!this.isActive()) {
      return;
    }

    const session = this.realtimeSession;
    this.connectionGeneration += 1;
    this.realtimeSession = null;
    this.subscriptions.disconnect();
    session?.close();
    if (scheduleReconnect) {
      this.scheduleReconnect();
    }
  }

  private async handlePolicyUpdated(storageStatus: SyncStorageStatus, generation: number): Promise<void> {
    if (!this.isCurrentConnection(generation)) {
      return;
    }

    this.subscriptions.reportPolicyStorageStatus(storageStatus);

    const session = this.realtimeSession;
    if (!session) {
      return;
    }

    const run = this.state.generation;
    try {
      if (await this.unblockFileSizeBlockedMutations(session, run)) {
        if (!this.shouldDeferSyncWork()) {
          void this.drain();
        }
      }
    } catch (error) {
      if (!this.isCurrentConnection(generation)) return;
      if (!isRealtimeConnectionError(error)) {
        this.handleError(error);
      }
    }
  }

  private async unblockFileSizeBlockedMutations(
    session: SyncRealtimeSession,
    run: number,
  ): Promise<boolean> {
    const unblocked = (await this.deps.unblockFileSizeBlockedMutations?.(session)) ?? 0;
    if (!this.state.isCurrent(run) || unblocked === 0) return false;

    // These changes are already durable. A reconnect within this run must keep
    // their upload notification even when the originating session was replaced.
    this.requestPush();
    this.reportQueuedWork();
    return true;
  }

  private async drain(force = false): Promise<void> {
    const run = this.state.generation;
    if (
      !this.isActive() ||
      (!force && (this.shouldDeferSyncWork() || this.timers.has("syncRetry")))
    ) {
      return await (this.drainPromise ?? Promise.resolve());
    }
    if (this.drainPromise) {
      await this.drainPromise;
      if (this.state.isCurrent(run)) await this.drain(force);
      return;
    }
    if (!this.hasPendingWork()) {
      return;
    }

    const running = this.drainUntilIdle(run);
    this.drainPromise = running;
    try {
      await running;
    } finally {
      if (this.drainPromise === running) {
        this.drainPromise = null;
      }
      if (this.shouldContinueDrain()) {
        void this.drain();
      }
    }
  }

  private async drainUntilIdle(run: number): Promise<void> {
    await this.runDrainLoop(run);
    while (this.state.isCurrent(run) && this.shouldContinueDrain()) {
      await this.runDrainLoop(run);
    }

    if (
      this.state.isCurrent(run) &&
      !this.hasPendingWork() &&
      !this.timers.has("reconnect") &&
      !this.timers.has("syncRetry")
    ) {
      this.state.set("live");
      this.deps.onIdle?.();
    }
  }

  private shouldContinueDrain(): boolean {
    return (
      this.isActive() &&
      this.hasPendingWork() &&
      !this.timers.has("reconnect") &&
      !this.timers.has("syncRetry") &&
      !this.shouldDeferSyncWork()
    );
  }

  private async runDrainLoop(run: number): Promise<void> {
    this.state.set("draining");
    while (this.state.isCurrent(run) && this.hasPendingWork()) {
      const work = this.takePendingWork();
      const shouldPush = work.push;
      const shouldPull = work.pullTargetCursor !== null;

      let shouldPullNow = shouldPull;
      let pushCompleted = !shouldPush;
      let staleMutations: StalePushMutation[] = [];
      try {
        let session: SyncRealtimeSession | null = null;
        if (shouldPush || shouldPullNow) {
          await this.ensureRealtimeSession();
          if (!this.state.isCurrent(run)) return;
          session = this.realtimeSession;
          if (!session) {
            if (shouldPush) {
              this.requestPush();
            }
            if (shouldPullNow) {
              this.requestPullWork(work.pullTargetCursor);
            }
            if (!this.timers.has("reconnect")) {
              this.scheduleSyncRetry();
            }
            return;
          }
        }

        // Recovery may have requested that a pending path owner commit first.
        if (shouldPullNow && !(shouldPush && this.pushPriorityEntryIds.length)) {
          if (!session) {
            throw new Error("Sync realtime session is not connected.");
          }
          await this.deps.pullOnce(session);
          if (!this.state.isCurrent(run)) return;
          shouldPullNow = false;
        }
        if (shouldPush) {
          if (!session) {
            throw new Error("Sync realtime session is not connected.");
          }
          const pushResult = await this.deps.pushPendingMutations(
            session,
            () => !this.state.isCurrent(run) || this.pendingWork.pullTargetCursor !== null,
            { priorityEntryIds: this.pushPriorityEntryIds },
          );
          if (!this.state.isCurrent(run)) return;
          pushCompleted = true;
          if (!pushResult.hasMore) this.pushPriorityEntryIds = [];
          staleMutations = pushResult.staleMutations ?? [];
          if (pushResult.stopReason === "storage_quota_exceeded") {
            try {
              await this.deps.onStorageQuotaExceeded?.();
            } finally {
              if (this.state.isCurrent(run)) {
                this.stop();
                this.deps.onTerminalStop?.({ type: "storage_quota_exceeded" });
              }
            }
            return;
          }
          shouldPullNow = shouldPullNow || pushResult.shouldPullAfterPush;
          if (pushResult.hasMore) {
            this.requestPush();
          }
        }
        if (shouldPullNow) {
          if (!session) {
            throw new Error("Sync realtime session is not connected.");
          }
          await this.deps.pullOnce(session);
          if (!this.state.isCurrent(run)) return;
          shouldPullNow = false;
        }
        if (session && staleMutations.length > 0) {
          let unresolved = await this.unresolvedStaleEntries(staleMutations);
          if (!this.state.isCurrent(run)) return;
          if (unresolved.length > 0 && this.deps.recoverEntryStates) {
            await this.deps.recoverEntryStates(session, unresolved);
            if (!this.state.isCurrent(run)) return;
            unresolved = await this.unresolvedStaleEntries(staleMutations);
            if (!this.state.isCurrent(run)) return;
          }
          if (unresolved.length > 0) {
            // An empty delta is not progress. Keep the pending mutations and
            // back off even if unrelated entries were committed successfully.
            throw new SyncRealtimeError(
              "stale_revision",
              "Sync could not reconcile an outdated file revision. Local changes are preserved; retrying with backoff.",
            );
          }
        }
        this.resetSyncRetry();
      } catch (error) {
        if (!this.state.isCurrent(run)) return;
        if (error instanceof RecoveryPendingDependenciesError) {
          this.pushPriorityEntryIds = error.entryIds;
          this.requestPush();
        }
        if (isCursorAheadOfServerError(error)) {
          this.stop();
          this.handleError(error);
          this.deps.onTerminalStop?.({ type: "sync_history_mismatch", error });
          return;
        }

        if (isRemoteVaultUnavailableError(error)) {
          this.handleRemoteVaultUnavailable(error);
          return;
        }

        if (shouldPush && !pushCompleted) {
          this.requestPush();
        }
        if (shouldPullNow) {
          this.requestPullWork(work.pullTargetCursor);
        }
        if (!isRealtimeConnectionError(error) && !(error instanceof DeviceFileRulesChangedError)) {
          this.handleError(error);
        }
        this.scheduleSyncRetry();
        return;
      }
    }
  }

  private async unresolvedStaleEntries(
    mutations: StalePushMutation[],
  ): Promise<string[]> {
    const store = this.deps.getSyncStore();
    if (!store) throw new Error("Sync store is not initialized.");
    const unresolved: string[] = [];
    for (const mutation of mutations) {
      const pending = await store.getDirtyEntryMutation(mutation.entryId);
      if (pending && pending.baseRevision <= mutation.baseRevision && !await this.deps.isDeferredEntry?.(mutation.entryId)) {
        unresolved.push(mutation.entryId);
      }
    }
    return unresolved;
  }

  private scheduleSyncRetry(): void {
    if (!this.isActive() || this.timers.has("syncRetry")) {
      return;
    }

    if (this.shouldDeferSyncWork()) {
      this.state.set("live");
      this.deps.onSyncDeferred?.();
      return;
    }

    this.state.set("retry_wait");
    const baseDelay = this.deps.syncRetryBaseDelayMs ?? DEFAULT_SYNC_RETRY_BASE_DELAY_MS;
    const maxDelay = this.deps.syncRetryMaxDelayMs ?? DEFAULT_SYNC_RETRY_MAX_DELAY_MS;
    const delay = Math.min(baseDelay * 2 ** this.syncRetryAttempt, maxDelay);
    this.syncRetryAttempt += 1;
    this.deps.onRetryScheduled?.({
      attempt: this.syncRetryAttempt,
      delayMs: delay,
    });
    this.timers.set("syncRetry", () => {
      if (!this.isActive() || !this.hasPendingWork()) {
        return;
      }

      this.deps.onSyncScheduled?.();
      void this.drain();
    }, delay);
  }

  private resetSyncRetry(): void {
    this.syncRetryAttempt = 0;
    this.timers.clear("syncRetry");
  }

  isActive(): boolean {
    return this.state.isActive();
  }

  private shouldDeferSyncWork(): boolean {
    return this.deps.shouldDeferSyncWork?.() ?? false;
  }

  private reportQueuedWork(): void {
    if (this.shouldDeferSyncWork()) {
      this.deps.onSyncDeferred?.();
    } else {
      this.deps.onSyncScheduled?.();
    }
  }

  private requestPush(): void {
    this.pendingWork.requestPush();
  }

  private requestPullWork(targetCursor: number | null): void {
    this.pendingWork.requestPull(targetCursor);
  }

  private hasPendingWork(): boolean {
    return this.pendingWork.hasPendingWork();
  }

  private takePendingWork() {
    return this.pendingWork.takePendingWork();
  }

  private handleError(error: unknown): void {
    if (isSyncPausedError(error)) {
      // The same pause can arrive through a session error, pending requests and close.
      if (!this.isActive()) return;
      this.stop();
      this.deps.onError?.(error);
      this.deps.onTerminalStop?.({ type: "sync_paused", error });
      return;
    }
    this.deps.onError?.(error);
  }

  private handleRemoteVaultUnavailable(error: RemoteVaultUnavailableError): void {
    this.stop();
    this.deps.onTerminalStop?.({ type: "remote_vault_unavailable", error });
    void this.deps.onRemoteVaultUnavailable?.(error);
  }
}

function isRealtimeConnectionError(error: unknown): boolean {
  return error instanceof SyncRealtimeConnectionError;
}

function isCursorAheadOfServerError(error: unknown): error is SyncRealtimeError {
  return (
    error instanceof SyncRealtimeError && error.code === "cursor_ahead_of_server"
  );
}
