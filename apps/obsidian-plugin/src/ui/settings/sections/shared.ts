export type RefreshSettings = () => void;

export interface SyncStatusSettingControls {
  refreshSyncStatus(): void;
  refreshStorageStatus(): void;
  refreshFileSizeBlockedWarning(): void;
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
