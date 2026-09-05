import { t } from "../../i18n";
import { formatSyncStatusLabel } from "../../i18n/sync-status";
import type {
  SynchStorageDisplayState,
  SynchStorageStatus,
  SynchSyncProgress,
  SynchSyncState,
} from "../contracts";
import { getStorageDisplayState as resolveStorageDisplayState } from "../../adapters/storage-warning";

export function shouldShowSyncSpinner(state: SynchSyncState): boolean {
  return state === "syncing" || state === "reconnecting";
}

export function formatSyncDescription(
  state: SynchSyncState,
  percent: number,
  syncProgress: SynchSyncProgress,
): string {
  const label = formatSyncStatusLabel(state, percent, syncProgress);
  if (syncProgress.direction) return label;
  return `${label} - ${syncProgress.completedEntries} / ${syncProgress.totalEntries}`;
}

export function formatStorageDescription(
  storageStatus: SynchStorageStatus | null,
  storageDisplayState: SynchStorageDisplayState = resolveStorageDisplayState(storageStatus),
): string {
  if (storageDisplayState === "needs_more_storage") {
    return t("storage.needsMore");
  }

  if (!storageStatus) {
    return t("storage.checking");
  }

  const usage = formatStorageUsage(storageStatus);
  if (storageDisplayState === "near_limit") {
    return t("storage.warning", { usage });
  }

  return usage;
}

function formatStorageUsage(
  storageStatus: SynchStorageStatus,
): string {
  if (storageStatus.storageLimitBytes <= 0) {
    return formatBytes(storageStatus.storageUsedBytes);
  }

  return [
    `${formatBytes(storageStatus.storageUsedBytes)} / ${formatBytes(storageStatus.storageLimitBytes)}`,
    `(${Math.round((storageStatus.storageUsedBytes / storageStatus.storageLimitBytes) * 100)}%)`,
  ].join(" ");
}

export function getStoragePercent(
  storageStatus: SynchStorageStatus,
): number {
  if (storageStatus.storageLimitBytes <= 0) {
    return 0;
  }

  const percent = (storageStatus.storageUsedBytes / storageStatus.storageLimitBytes) * 100;
  return Math.min(100, Math.max(0, Math.round(percent)));
}

export function formatDeletedFileTimestamp(value: number): string {
  return new Date(value).toLocaleString();
}

function formatBytes(bytes: number): string {
  const safeBytes = Math.max(0, bytes);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = safeBytes;
  let unitIndex = 0;
  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000;
    unitIndex += 1;
  }

  if (unitIndex === 0) {
    return `${safeBytes} B`;
  }

  const rounded = Math.round(value * 10) / 10;
  return `${rounded.toLocaleString("en-US")} ${units[unitIndex]}`;
}
