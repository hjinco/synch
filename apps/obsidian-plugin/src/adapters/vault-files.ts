import { TAbstractFile, TFile } from "obsidian";

import type { SyncFileRules } from "@synch/sync-client/sync/core/file-rules";
import { normalizeVaultPath, shouldSyncPath } from "@synch/sync-client/sync/core/file-rules";

export function asSyncableFile(
  file: TAbstractFile,
  rules: SyncFileRules,
  configDir = "",
): TFile | null {
  return file instanceof TFile && isSyncableVaultPath(file.path, rules, configDir)
    ? file
    : null;
}

export function isSyncableVaultPath(
  path: string,
  rules: SyncFileRules,
  configDir = "",
): boolean {
  const normalized = normalizeVaultPath(path);
  return !!normalized && shouldSyncPath(normalized, rules, configDir);
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}
