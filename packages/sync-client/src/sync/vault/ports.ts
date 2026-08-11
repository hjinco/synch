import type { ConflictFileWriter } from "../core/conflict-file";
import type { SyncVaultWriter } from "./vault-writer";

export interface SyncVaultFile {
  path: string;
  mtime: number;
  size: number;
  readBytes(): Promise<Uint8Array>;
}

export interface SyncVaultScanner {
  listFiles(): Promise<SyncVaultFile[]>;
}

export interface SyncVaultAccess extends ConflictFileWriter, SyncVaultWriter {
  readBytes(path: string): Promise<Uint8Array>;
}

export interface SyncVaultAdapter extends SyncVaultAccess, SyncVaultScanner {}
