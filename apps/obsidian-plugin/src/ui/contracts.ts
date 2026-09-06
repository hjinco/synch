import type { UserVisibleSyncProgress } from "@synch/sync-client/engine";
import type { SyncFileRules, VaultConfigSyncRules } from "@synch/sync-client/core";

// The only type bridge allowed so the ui layer never imports feature modules
// directly.
export type { AuthReadiness } from "@synch/sync-client/auth";

export type SynchFileRules = SyncFileRules;

export type SynchVaultConfigSyncRules = VaultConfigSyncRules;

/**
 * Obsidian's undocumented settings-modal API, present on `App` at runtime.
 * Kept optional so callers degrade gracefully if Obsidian changes it.
 */
export interface ObsidianSettingsApi {
  open(): void;
  openTabById(id: string): void;
}

export interface AppWithSettings {
  setting?: ObsidianSettingsApi;
}

export type SynchSyncState =
  | "not_ready"
  | "paused"
  | "pending"
  | "reconciling"
  | "syncing"
  | "offline"
  | "reconnecting"
  | "up_to_date"
  | "attention_needed"
  | "update_required";

export type SynchSyncProgress = UserVisibleSyncProgress;

export interface SynchSyncLogs {
  count: number;
  text: string;
}

export interface SynchStorageStatus {
  storageUsedBytes: number;
  storageLimitBytes: number;
}

export type SynchStorageDisplayState =
  | "normal"
  | "near_limit"
  | "needs_more_storage";

export interface SynchFileSizeBlockedFile {
  path: string;
  encryptedSizeBytes: number | null;
  maxFileSizeBytes: number | null;
}

export type SynchCommunityPluginUpdateStatus =
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
      state: "failed";
      currentVersion: string;
      error: string;
    };

export type SynchServerCompatibilityStatus =
  | {
      state: "idle";
    }
  | {
      state: "ok";
      currentVersion: string;
      minVersion: string;
      apiMajor: number;
    }
  | {
      state: "update_required";
      currentVersion: string;
      minVersion: string;
      message: string;
    }
  | {
      state: "incompatible";
      currentVersion: string;
      minVersion: string;
      apiMajor: number;
      message: string;
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
