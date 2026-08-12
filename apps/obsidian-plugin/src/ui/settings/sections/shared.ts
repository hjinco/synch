export type RefreshSettings = () => void;

export interface SyncRowSettingControls {
  refreshSyncStatus(): void;
  refreshFileSizeBlockedWarning(): void;
}

export interface StorageRowSettingControls {
  refreshStorageStatus(): void;
}

export interface SyncDiagnosticsSettingControls {
  refreshSyncLogs(): void;
}

export interface FileSizeBlockedWarningControls {
  refreshFileSizeBlockedWarning(): void;
}

export interface ProgressBarControl {
  setValue(value: number): ProgressBarControl;
}
