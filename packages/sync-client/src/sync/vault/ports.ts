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

export interface SyncVaultPathAliases {
  /** Whether two existing vault paths are alternate spellings of one directory entry. */
  areSameFilePaths?(first: string, second: string): Promise<boolean>;
}

export interface SyncVaultScanner extends SyncVaultPathExclusions, SyncVaultPathAliases {
  listFiles(): Promise<SyncVaultFile[]>;
}

export interface SyncVaultAccess extends ConflictFileWriter, SyncVaultWriter, SyncVaultPathExclusions, SyncVaultPathAliases {
  /** Count all siblings, including hidden or excluded files, before renaming a parent. */
  isOnlyChild?(path: string): Promise<boolean>;
  /** Content writes leave either the previous or the complete new file on disk. */
  readonly atomicWrites?: boolean;
  /** Restore files held by an interrupted host write before inspecting the vault. */
  recoverInterruptedWrites?(): Promise<void>;
  /** Install recovery bytes only if the destination still has no file. */
  writeBytesIfAbsent?(path: string, bytes: Uint8Array, operationId: string): Promise<boolean>;
  discardStagedWrite?(operationId: string): Promise<void>;
  statKind?(path: string): Promise<"file" | "folder" | null>;
  /** A text-only host may decode different source bytes to the same string. */
  canCompareTextForWrite?(expected: string | Uint8Array, path: string): boolean;
  writeTextIfUnchanged?(path: string, expected: string | Uint8Array, replacement: string): Promise<boolean>;
  readBytes(path: string): Promise<Uint8Array>;
  getFileSize(path: string): Promise<number>;
}

export interface SyncVaultAdapter extends SyncVaultAccess, SyncVaultScanner {}
