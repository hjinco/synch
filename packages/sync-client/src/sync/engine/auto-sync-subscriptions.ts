import type { PresenceSelection } from "../core/presence";
import {
  SyncRealtimeConnectionError,
  type SyncRealtimeSession,
  type SyncStorageStatus,
} from "../remote/realtime-client";

interface SyncSessionSubscriptionsDeps {
  getSession: () => SyncRealtimeSession | null;
  onStorageStatusChange?: (status: SyncStorageStatus | null) => void;
  onPresenceAvailabilityChanged?: (enabled: boolean) => void;
  onPresenceSessionReset?: () => void;
  onError: (error: unknown) => void;
}

/** Keeps watch preferences across connections; the loop owns the session itself. */
export class SyncSessionSubscriptions {
  private storageStatusWatching = false;
  private presenceWatching = false;
  private presenceWatchEntryIds: string[] = [];
  private presenceWatchSent = false;
  private presenceAvailable = false;
  private presenceSupported = true;
  private presenceCleared = false;

  constructor(private readonly deps: SyncSessionSubscriptionsDeps) {}

  restore(session: SyncRealtimeSession): void {
    this.presenceSupported = session.presenceSupported !== false;
    this.presenceWatchSent = false;
    this.setPresenceAvailability(false);
    if (this.storageStatusWatching) {
      this.applyStorageStatusWatch();
    }
    if (this.presenceWatching && this.presenceSupported) {
      this.applyPresenceWatch();
    }
  }

  resetPresence(): void {
    this.presenceWatchSent = false;
    this.setPresenceAvailability(false);
    this.deps.onPresenceSessionReset?.();
  }

  disconnect(): void {
    this.presenceWatchSent = false;
    this.deps.onStorageStatusChange?.(null);
    this.resetPresence();
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

  reportPolicyStorageStatus(status: SyncStorageStatus): void {
    if (this.storageStatusWatching) {
      this.deps.onStorageStatusChange?.(status);
    }
  }

  setPresenceWatching(enabled: boolean): void {
    if (this.presenceWatching === enabled) {
      if (enabled && !this.presenceWatchSent) {
        this.applyPresenceWatch();
      }
      return;
    }

    this.presenceWatching = enabled;
    if (!enabled) {
      this.presenceWatchEntryIds = [];
      this.setPresenceAvailability(false);
      this.deps.onPresenceSessionReset?.();
    }
    this.applyPresenceWatch();
  }

  setPresenceWatchEntryIds(entryIds: string[]): void {
    const normalizedEntryIds = normalizePresenceEntryIds(entryIds);
    if (samePresenceEntryIds(this.presenceWatchEntryIds, normalizedEntryIds)) {
      return;
    }

    this.presenceWatchEntryIds = normalizedEntryIds;
    this.presenceWatchSent = false;
    if (this.presenceWatching) {
      this.applyPresenceWatch();
    }
  }

  setPresenceAvailability(enabled: boolean): void {
    if (this.presenceAvailable === enabled) {
      return;
    }
    this.presenceAvailable = enabled;
    this.presenceCleared = false;
    this.deps.onPresenceAvailabilityChanged?.(enabled);
  }

  updatePresence(entryId: string, selection: PresenceSelection): void {
    if (this.canPublishPresence()) {
      this.withSession((session) => {
        session.updatePresence(entryId, selection);
        this.presenceCleared = false;
      });
    }
  }

  clearPresence(): void {
    if (this.canPublishPresence() && !this.presenceCleared) {
      this.withSession((session) => {
        session.clearPresence();
        // Remember only a successful send. Availability changes reset this
        // so a restored session can synchronize its empty state again.
        this.presenceCleared = true;
      });
    }
  }

  private canPublishPresence(): boolean {
    return this.presenceWatching && this.presenceSupported && this.presenceAvailable;
  }

  private applyStorageStatusWatch(): void {
    this.withSession((session) => {
      if (this.storageStatusWatching) {
        session.watchStorageStatus();
        this.deps.onStorageStatusChange?.({
          storageUsedBytes: session.storageUsedBytes,
          storageLimitBytes: session.storageLimitBytes,
        });
      } else {
        session.unwatchStorageStatus();
      }
    });
  }

  private applyPresenceWatch(): void {
    if (!this.presenceSupported) {
      return;
    }

    this.withSession((session) => {
      if (this.presenceWatching) {
        if (this.presenceWatchSent) {
          return;
        }
        session.watchPresence(this.presenceWatchEntryIds);
        this.presenceWatchSent = true;
      } else {
        if (!this.presenceWatchSent) {
          return;
        }
        session.unwatchPresence();
        this.presenceWatchSent = false;
      }
    });
  }

  private withSession(work: (session: SyncRealtimeSession) => void): void {
    const session = this.deps.getSession();
    if (!session) {
      return;
    }

    try {
      work(session);
    } catch (error) {
      // Connection failures are handled by the loop's close/reconnect path.
      if (!(error instanceof SyncRealtimeConnectionError)) {
        this.deps.onError(error);
      }
    }
  }
}

function normalizePresenceEntryIds(entryIds: string[]): string[] {
  return [...new Set(entryIds.map((entryId) => entryId.trim()).filter(Boolean))].slice(0, 100);
}

function samePresenceEntryIds(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const rightSet = new Set(right);
  return left.every((entryId) => rightSet.has(entryId));
}
