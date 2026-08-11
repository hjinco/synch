import { t } from "../i18n";
import {
  getUserVisibleSyncDisplayPercent,
  type UserVisibleSyncProgress,
  type UserVisibleSyncState,
} from "../sync/runtime/user-visible-status";

export function formatSyncStatusLabel(
  state: UserVisibleSyncState,
  progress: UserVisibleSyncProgress | null = null,
): string {
  const percent = getUserVisibleSyncDisplayPercent(state, progress);
  return t("sync.status", {
    label: t(`sync.state.${state}`),
    percent,
  });
}
