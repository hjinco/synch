import type { SyncTokenResponse } from "../remote/client";
import {
  isRemoteVaultUnavailableError,
  remoteVaultUnavailableFromWebSocketClose,
  type RemoteVaultUnavailableError,
} from "../../remote-vault/unavailable";
import type { PushPendingMutationsResult } from "./push-service";
import {
  SyncRealtimeClient,
  SyncRealtimeConnectionError,
  SyncRealtimeError,
  type SyncRealtimeSession,
  type SyncStorageStatus,
} from "../remote/realtime-client";
import type { SyncCursorStore } from "../store/ports";
import { SyncAutoLoopState, type SyncConnectionState } from "./auto-sync-state";
import { AutoSyncTimers } from "./auto-sync-timers";
import { PendingSyncWorkQueue } from "./auto-sync-work-queue";

const DEFAULT_PUSH_DEBOUNCE_MS = 300;
const DEFAULT_RECONNECT_DELAY_MS = 3_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;
const DEFAULT_SYNC_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_SYNC_RETRY_MAX_DELAY_MS = 30_000;

export interface SyncAutoLoopDeps {
  getApiBaseUrl: () => string;
  getSyncToken: () => Promise<SyncTokenResponse>;
  getSyncStore: () => SyncCursorStore | null;
  pushPendingMutations: (
    session: SyncRealtimeSession,
  ) => Promise<PushPendingMutationsResult>;
  unblockFileSizeBlockedMutations?: (
    session: SyncRealtimeSession,
  ) => Promise<number>;
  pullOnce: (session: SyncRealtimeSession) => Promise<unknown>;
  realtimeClient: SyncRealtimeClientLike;
  pushDebounceMs?: number;
  reconnectDelayMs?: number;
  reconnectMaxDelayMs?: number;
  syncRetryBaseDelayMs?: number;
  syncRetryMaxDelayMs?: number;
  shouldDeferSyncWork?: () => boolean;
  onConnectionStateChange?: (state: SyncConnectionState) => void;
  onStorageStatusChange?: (status: SyncStorageStatus | null) => void;
  onSyncScheduled?: () => void;
  onSyncDeferred?: () => void;
  onIdle?: () => void;
  onRetryScheduled?: (input: { attempt: number; delayMs: number }) => void;
  onError?: (error: unknown) => void;
  onRemoteVaultUnavailable?: (error: RemoteVaultUnavailableError) => void | Promise<void>;
  onStorageQuotaExceeded?: () => void | Promise<void>;
}

export interface SyncRealtimeClientLike {
  openSession: SyncRealtimeClient["openSession"];
}

export class SyncAutoLoop {
  private readonly realtimeClient: SyncRealtimeClientLike;
  private realtimeSession: SyncRealtimeSession | null = null;
  private connectPromise: Promise<void> | null = null;
  private drainPromise: Promise<void> | null = null;
  private readonly timers = new AutoSyncTimers();
  private reconnectAttempt = 0;
  private syncRetryAttempt = 0;
  private readonly state: SyncAutoLoopState;
  private storageStatusWatching = false;
  private readonly pendingWork = new PendingSyncWorkQueue();

  constructor(private readonly deps: SyncAutoLoopDeps) {
    this.realtimeClient = deps.realtimeClient;
    this.state = new SyncAutoLoopState(deps.onConnectionStateChange);
  }

  async start(): Promise<boolean> {
    if (this.isActive()) {
      return false;
    }

    this.state.set("live");
    await this.ensureRealtimeSession();
    return true;
  }

  stop(): void {
    this.state.set("stopped");
    this.pendingWork.clear();
    this.timers.clearAll();
    this.realtimeSession?.close();
    this.realtimeSession = null;
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

    this.timers.clear("push");
    this.deps.onSyncScheduled?.();
    this.requestPullWork(null);
    this.requestPush();
    await this.drain(true);
    return (
      this.isActive() &&
      !this.hasPendingWork() &&
      !this.timers.has("syncRetry") &&
      !this.timers.has("reconnect")
    );
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
    if (this.storageStatusWatching === enabled) {
      return;
    }

    this.storageStatusWatching = enabled;
    if (!enabled) {
      this.deps.onStorageStatusChange?.(null);
    }
    this.applyStorageStatusWatch();
  }

  async ensureRealtimeSession(): Promise<void> {
    if (!this.isActive() || this.realtimeSession || this.connectPromise) {
      return await (this.connectPromise ?? Promise.resolve());
    }

    this.connectPromise = this.openRealtimeSession();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async withRealtimeSession<T>(
    work: (session: SyncRealtimeSession) => Promise<T>,
  ): Promise<T> {
    if (!this.isActive()) {
      this.state.set("live");
    }

    await this.ensureRealtimeSession();
    const session = this.realtimeSession;
    if (!session) {
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
    if (!this.isActive() || this.realtimeSession) {
      return;
    }

    this.timers.clear("reconnect");
    await this.ensureRealtimeSession();
  }

  private async openRealtimeSession(): Promise<void> {
    try {
      this.state.set("connecting");
      const store = this.deps.getSyncStore();
      if (!store) {
        throw new Error("Sync store is not initialized.");
      }

      const token = await this.deps.getSyncToken();
      const cursor = await store.getCursor();
      const session = await this.realtimeClient.openSession(
        this.deps.getApiBaseUrl(),
        token,
        cursor,
        {
          onCursorAdvanced: (nextCursor) => {
            this.requestPull(nextCursor);
          },
          onStorageStatusUpdated: (status) => {
            this.deps.onStorageStatusChange?.(status);
          },
          onPolicyUpdated: (_policy, storageStatus) => {
            void this.handlePolicyUpdated(storageStatus);
          },
          onClose: (event) => {
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
            if (
              !isRealtimeConnectionError(error) &&
              !isCursorAheadOfServerError(error)
            ) {
              this.handleError(error);
            }
          },
        },
      );
      if (!this.isActive()) {
        session.close();
        return;
      }

      this.realtimeSession = session;
      try {
        if (cursor > session.serverCursor) {
          throw new SyncRealtimeError(
            "cursor_ahead_of_server",
            "Sync was paused because this device's sync history no longer matches the remote vault. To resume syncing, disconnect and reconnect the remote vault in Synch settings.",
          );
        }
        this.reconnectAttempt = 0;
        if (this.storageStatusWatching) {
          this.applyStorageStatusWatch();
        }
        const unblockedFileSizeMutations =
          (await this.deps.unblockFileSizeBlockedMutations?.(session)) ?? 0;
        if (unblockedFileSizeMutations > 0) {
          this.requestPush();
          this.reportQueuedWork();
        }
        if (session.serverCursor > cursor) {
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
        if (this.realtimeSession === session) {
          this.realtimeSession = null;
        }
        session.close();
        throw error;
      }
    } catch (error) {
      if (isCursorAheadOfServerError(error)) {
        this.stop();
        this.handleError(error);
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
    this.realtimeSession = null;
    this.deps.onStorageStatusChange?.(null);
    session?.close();
    if (scheduleReconnect) {
      this.scheduleReconnect();
    }
  }

  private async handlePolicyUpdated(storageStatus: SyncStorageStatus): Promise<void> {
    if (!this.isActive()) {
      return;
    }

    if (this.storageStatusWatching) {
      this.deps.onStorageStatusChange?.(storageStatus);
    }

    const session = this.realtimeSession;
    if (!session) {
      return;
    }

    try {
      const unblockedFileSizeMutations =
        (await this.deps.unblockFileSizeBlockedMutations?.(session)) ?? 0;
      if (unblockedFileSizeMutations > 0) {
        this.requestPush();
        this.reportQueuedWork();
        if (!this.shouldDeferSyncWork()) {
          void this.drain();
        }
      }
    } catch (error) {
      if (!isRealtimeConnectionError(error)) {
        this.handleError(error);
      }
    }
  }

  private applyStorageStatusWatch(): void {
    const session = this.realtimeSession;
    if (!session) {
      return;
    }

    try {
      if (this.storageStatusWatching) {
        session.watchStorageStatus();
        this.deps.onStorageStatusChange?.({
          storageUsedBytes: session.storageUsedBytes,
          storageLimitBytes: session.storageLimitBytes,
        });
      } else {
        session.unwatchStorageStatus();
      }
    } catch (error) {
      if (!isRealtimeConnectionError(error)) {
        this.handleError(error);
      }
    }
  }

  private async drain(force = false): Promise<void> {
    if (!this.isActive() || (!force && this.shouldDeferSyncWork()) || this.drainPromise) {
      return await (this.drainPromise ?? Promise.resolve());
    }
    this.drainPromise = this.runDrainLoop();
    try {
      await this.drainPromise;
    } finally {
      this.drainPromise = null;
      if (
        this.isActive() &&
        this.hasPendingWork() &&
        !this.timers.has("reconnect") &&
        !this.timers.has("syncRetry")
      ) {
        void this.drain();
      }
    }

    if (
      this.isActive() &&
      !this.hasPendingWork() &&
      !this.timers.has("reconnect") &&
      !this.timers.has("syncRetry")
    ) {
      this.state.set("live");
      this.deps.onIdle?.();
    }
  }

  private async runDrainLoop(): Promise<void> {
    this.state.set("draining");
    while (this.isActive() && this.hasPendingWork()) {
      const work = this.takePendingWork();
      const shouldPush = work.push;
      const shouldPull = work.pullTargetCursor !== null;

      let shouldPullNow = shouldPull;
      let pushCompleted = !shouldPush;
      try {
        let session: SyncRealtimeSession | null = null;
        if (shouldPush || shouldPullNow) {
          await this.ensureRealtimeSession();
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

        if (shouldPullNow) {
          if (!session) {
            throw new Error("Sync realtime session is not connected.");
          }
          await this.deps.pullOnce(session);
          shouldPullNow = false;
        }
        if (shouldPush) {
          if (!session) {
            throw new Error("Sync realtime session is not connected.");
          }
          const pushResult = await this.deps.pushPendingMutations(session);
          pushCompleted = true;
          if (pushResult.stopReason === "storage_quota_exceeded") {
            try {
              await this.deps.onStorageQuotaExceeded?.();
            } finally {
              this.stop();
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
        }
        this.resetSyncRetry();
      } catch (error) {
        if (isCursorAheadOfServerError(error)) {
          this.stop();
          this.handleError(error);
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
        if (!isRealtimeConnectionError(error)) {
          this.handleError(error);
        }
        this.scheduleSyncRetry();
        return;
      }
    }
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

  private isActive(): boolean {
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
    this.deps.onError?.(error);
  }

  private handleRemoteVaultUnavailable(error: RemoteVaultUnavailableError): void {
    this.stop();
    void this.deps.onRemoteVaultUnavailable?.(error);
  }
}

function isRealtimeConnectionError(error: unknown): boolean {
  return error instanceof SyncRealtimeConnectionError;
}

function isCursorAheadOfServerError(error: unknown): boolean {
  return (
    error instanceof SyncRealtimeError && error.code === "cursor_ahead_of_server"
  );
}
