import type { PresenceUpdatedPush } from "@synch/sync-client/remote";

export type { PresenceUpdatedPush };

export interface PresenceRelay {
  onUpdated(update: PresenceUpdatedPush): void;
  onCleared(presenceId: string): void;
  onAvailabilityChanged(enabled: boolean): void;
  onReset(): void;
}
