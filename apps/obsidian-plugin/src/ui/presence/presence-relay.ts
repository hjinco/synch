import type { PresenceUpdatedPush } from "@synch/sync-client/sync/remote/realtime-types";

export type { PresenceUpdatedPush };

export interface PresenceRelay {
  onUpdated(update: PresenceUpdatedPush): void;
  onCleared(presenceId: string): void;
  onAvailabilityChanged(enabled: boolean): void;
  onReset(): void;
}
