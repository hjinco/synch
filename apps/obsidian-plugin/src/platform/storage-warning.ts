export interface StorageWarningStatus {
  storageUsedBytes: number;
  storageLimitBytes: number;
}

export const STORAGE_WARNING_RATIO = 0.95;

export function getStorageUsageRatio(status: StorageWarningStatus): number | null {
  if (status.storageLimitBytes <= 0) {
    return null;
  }

  return status.storageUsedBytes / status.storageLimitBytes;
}

export function isStorageWarningStatus(
  status: StorageWarningStatus | null,
): boolean {
  if (!status) {
    return false;
  }

  const ratio = getStorageUsageRatio(status);
  return ratio !== null && ratio >= STORAGE_WARNING_RATIO;
}

export function isStorageFullStatus(status: StorageWarningStatus): boolean {
  const ratio = getStorageUsageRatio(status);
  return ratio !== null && ratio >= 1;
}
