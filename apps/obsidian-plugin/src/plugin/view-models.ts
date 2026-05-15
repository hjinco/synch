export interface SynchFileRules {
  includeImages: boolean;
  includeAudio: boolean;
  includeVideos: boolean;
  includePdf: boolean;
  includeOtherFiles: boolean;
  excludedFolders: string[];
  includedHiddenFolders: string[];
}

export type SynchSyncState =
  | "not_ready"
  | "paused"
  | "syncing"
  | "offline"
  | "reconnecting"
  | "up_to_date"
  | "attention_needed"
  | "update_required";

export interface SynchSyncProgress {
  completedEntries: number;
  totalEntries: number;
}

export interface SynchStorageStatus {
  storageUsedBytes: number;
  storageLimitBytes: number;
}

export interface SynchFileSizeBlockedFile {
  path: string;
  encryptedSizeBytes: number | null;
  maxFileSizeBytes: number | null;
}

export type SynchPluginUpdateStatus =
  | {
      state: "idle" | "checking";
      currentVersion: string;
    }
  | {
      state: "up_to_date";
      currentVersion: string;
      latestVersion: string;
    }
  | {
      state: "update_available";
      currentVersion: string;
      latestVersion: string;
    }
  | {
      state: "update_required";
      currentVersion: string;
      minVersion: string;
      message: string;
    }
  | {
      state: "failed";
      currentVersion: string;
      error: string;
    };

export type SynchSubscriptionStatus =
  | {
      state: "idle" | "checking";
    }
  | {
      state: "loaded";
      planId: "free" | "starter" | "self_hosted";
      billingInterval: "monthly" | "annual" | null;
      active: boolean;
      status: string;
      cancelAtPeriodEnd: boolean;
      periodEnd: string | null;
    }
  | {
      state: "failed";
      error: string;
    };

export interface SynchDeletedFile {
  entryId: string;
  path: string;
  revision: number;
  deletedAt: number;
}

export interface SynchDeletedFileCursor {
  deletedAt: number;
  entryId: string;
}

export interface SynchDeletedFilesPage {
  files: SynchDeletedFile[];
  hasMore: boolean;
  nextBefore: SynchDeletedFileCursor | null;
}

export interface SynchDeletedFilesRestoreResult {
  restored: number;
  failures: SynchDeletedFileRestoreFailure[];
}

export interface SynchDeletedFileRestoreFailure {
  entryId: string;
  message: string;
}

export interface SynchDeletedFilesPurgeResult {
  purged: number;
  failures: SynchDeletedFilePurgeFailure[];
}

export interface SynchDeletedFilePurgeFailure {
  entryId: string;
  message: string;
}

export interface SynchEntryVersionCursor {
  capturedAt: number;
  versionId: string;
}

export interface SynchEntryVersion {
  versionId: string;
  sourceRevision: number;
  op: "upsert" | "delete";
  hasBlob: boolean;
  reason: "auto" | "before_delete" | "before_restore" | "manual";
  capturedAt: number;
}

export interface SynchEntryVersionsPage {
  path: string;
  dirty: boolean;
  versions: SynchEntryVersion[];
  hasMore: boolean;
  nextBefore: SynchEntryVersionCursor | null;
}

export type SynchVersionPreview =
  | {
      status: "text";
      path: string;
      reason: SynchEntryVersion["reason"];
      capturedAt: number;
      text: string;
      currentText?: string;
    }
  | {
      status: "image";
      path: string;
      reason: SynchEntryVersion["reason"];
      capturedAt: number;
      mimeType: string;
      bytes: Uint8Array;
    }
  | {
      status: "unavailable";
      path: string;
      reason: SynchEntryVersion["reason"] | null;
      capturedAt: number | null;
      message: string;
    };
