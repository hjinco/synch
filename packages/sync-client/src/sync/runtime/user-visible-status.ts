export type UserVisibleSyncState =
  | "not_ready"
  | "paused"
  | "pending"
  | "syncing"
  | "offline"
  | "reconnecting"
  | "up_to_date"
  | "attention_needed";

interface SyncProgressCounts {
  completedEntries: number;
  totalEntries: number;
}

/** Whole-vault status, independent of any active sync operation. */
export interface VaultSyncProgress extends SyncProgressCounts {
  direction?: never;
  totalKnown?: never;
}

/** Work discovered and completed during a single push or pull invocation. */
export interface SyncOperationProgress extends SyncProgressCounts {
  direction: "push" | "pull";
  totalKnown: boolean;
}

export type UserVisibleSyncProgress = VaultSyncProgress | SyncOperationProgress;

export function getUserVisibleSyncPercent(
  progress: UserVisibleSyncProgress | null,
): number | null {
  if (!progress || progress.totalKnown === false || progress.totalEntries <= 0) {
    return null;
  }

  return Math.floor((progress.completedEntries / progress.totalEntries) * 100);
}

export function getUserVisibleSyncDisplayPercent(
  state: UserVisibleSyncState,
  progress: UserVisibleSyncProgress | null = null,
): number {
  const percent = getUserVisibleSyncPercent(progress);
  if (percent !== null) {
    return percent;
  }

  if (state === "up_to_date") {
    return 100;
  }

  return 0;
}
