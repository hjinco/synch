import type { ConflictFileWriter } from "../core/conflict-file";
import type { SyncVaultWriter } from "./vault-writer";

export interface SyncVaultFile {
  path: string;
  mtime: number;
  size: number;
  readBytes(): Promise<Uint8Array>;
}

/** Host filesystem exclusions, distinct from missing files and user filters. */
export interface SyncVaultPathExclusions {
  isExcludedPath?(path: string): Promise<boolean>;
}

export interface SyncVaultScanner extends SyncVaultPathExclusions {
  listFiles(): Promise<SyncVaultFile[]>;
}

export interface SyncVaultAccess extends ConflictFileWriter, SyncVaultWriter, SyncVaultPathExclusions {
  readBytes(path: string): Promise<Uint8Array>;
  getFileSize(path: string): Promise<number>;
}

export interface SyncVaultAdapter extends SyncVaultAccess, SyncVaultScanner {}
