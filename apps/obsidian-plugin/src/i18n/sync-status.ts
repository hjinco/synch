import { t } from "./index";
import type { UserVisibleSyncState } from "@synch/sync-client/sync/runtime/user-visible-status";

export type SynchDisplaySyncState = UserVisibleSyncState | "update_required";

export function formatSyncStatusLabel(
  state: SynchDisplaySyncState,
  percent: number,
): string {
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
