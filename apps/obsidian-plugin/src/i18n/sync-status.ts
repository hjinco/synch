import type {
  UserVisibleSyncProgress,
  UserVisibleSyncState,
} from "@synch/sync-client/engine";

import { t } from "./index";

export type SynchDisplaySyncState = UserVisibleSyncState | "update_required";

export function formatSyncStatusLabel(
  state: SynchDisplaySyncState,
  percent: number,
  progress?: UserVisibleSyncProgress,
): string {
  if (state === "reconciling") {
    return t("sync.state.reconciling");
  }

  if (state === "syncing" && progress?.direction) {
    const label = t(progress.direction === "pull" ? "sync.downloading" : "sync.uploading");
    const count = progress.totalKnown === false
      ? t("sync.completedCount", { count: progress.completedEntries })
      : t("sync.completedTotal", { count: progress.completedEntries, total: progress.totalEntries });
    const status = progress.totalKnown !== false && progress.totalEntries > 0
      ? t("sync.status", { label, percent })
      : label;
    return `${status} · ${count}`;
  }
  if (state === "update_required") {
    return t("plugin.updateRequiredStatus");
  }

  if (state === "paused") {
    return t("sync.state.paused");
  }

  return t("sync.status", {
    label: t(`sync.state.${state}`),
    percent,
  });
}
