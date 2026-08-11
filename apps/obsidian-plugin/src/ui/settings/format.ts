import { t } from "../../i18n";
import type { SynchSyncProgress, SynchSyncState } from "../contracts";
import {
  isStorageFullStatus,
  isStorageWarningStatus,
} from "../../platform/storage-warning";
import type { SynchSettingsController } from "./controller";

export function shouldShowSyncSpinner(state: SynchSyncState): boolean {
  return state === "syncing" || state === "reconnecting";
}

export function formatSyncDescription(
  statusLabel: string,
  syncProgress: SynchSyncProgress,
): string {
  const label = formatSyncStatusLabel(statusLabel);
  return `${label} - ${syncProgress.completedEntries} / ${syncProgress.totalEntries}`;
}

export function formatStorageDescription(
  storageStatus: NonNullable<ReturnType<SynchSettingsController["getStorageStatus"]>>,
): string {
  const usage = formatStorageUsage(storageStatus);
  if (isStorageFullStatus(storageStatus)) {
    return t("storage.full", { usage });
  }
  if (isStorageWarningStatus(storageStatus)) {
    return t("storage.warning", { usage });
  }

  return usage;
}

function formatSyncStatusLabel(statusLabel: string): string {
  const label = statusLabel
    .replace(/^(Sync|동기화|同期|同步):\s*/, "")
    .replace(/^paused \d+%$/, "paused")
    .replace(/^일시 중지됨 \d+%$/, t("sync.state.paused"));

  const translated = label
    .replace(/^not ready/, t("sync.state.not_ready"))
    .replace(/^paused/, t("sync.state.paused"))
    .replace(/^waiting to sync/, t("sync.state.pending"))
    .replace(/^syncing/, t("sync.state.syncing"))
    .replace(/^offline/, t("sync.state.offline"))
    .replace(/^reconnecting/, t("sync.state.reconnecting"))
    .replace(/^up to date/, t("sync.state.up_to_date"))
    .replace(/^attention needed/, t("sync.state.attention_needed"));
  return translated;
}

function formatStorageUsage(
  storageStatus: NonNullable<ReturnType<SynchSettingsController["getStorageStatus"]>>,
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
  storageStatus: NonNullable<ReturnType<SynchSettingsController["getStorageStatus"]>>,
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
