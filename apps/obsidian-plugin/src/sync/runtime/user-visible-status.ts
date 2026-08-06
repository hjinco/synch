import { t } from "../../i18n";

export type UserVisibleSyncState =
  | "not_ready"
  | "paused"
  | "pending"
  | "syncing"
  | "offline"
  | "reconnecting"
  | "up_to_date"
  | "attention_needed";

export interface UserVisibleSyncProgress {
  completedEntries: number;
  totalEntries: number;
}

export function getUserVisibleSyncPercent(
  progress: UserVisibleSyncProgress | null,
): number | null {
  if (!progress || progress.totalEntries <= 0) {
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

export function formatUserVisibleSyncState(
  state: UserVisibleSyncState,
  progress: UserVisibleSyncProgress | null = null,
): string {
  const percent = getUserVisibleSyncDisplayPercent(state, progress);
  return t("sync.status", {
    label: t(`sync.state.${state}`),
    percent,
  });
}
