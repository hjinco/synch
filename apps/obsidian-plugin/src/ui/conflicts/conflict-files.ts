import { getConflictOriginalPath } from "@synch/sync-client/core";

import type { SynchConflictFile } from "../contracts";

/** What the user chose for one conflict copy. */
export type ConflictAction = "keep-original" | "keep-copy" | "merge";

/** Minimal view of a vault file, so this module stays testable without Obsidian. */
export interface ConflictVaultFile {
  path: string;
  stat: { size: number; mtime: number };
}

/**
 * Finds conflict copies in the vault and pairs each with the file it was made
 * from.
 *
 * A `.sync-conflict-<timestamp>` copy *is* the conflict record: it holds the
 * content sync could not merge, sitting next to the original. There is no
 * separate store to consult, so this is the whole "what conflicts exist?"
 * question.
 *
 * The original may be missing — a path collision can leave the copy as the only
 * surviving version — so `originalExists` is reported rather than assumed.
 */
export function findConflictFiles(
  files: readonly ConflictVaultFile[],
): SynchConflictFile[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const conflicts: SynchConflictFile[] = [];

  for (const file of files) {
    const originalPath = getConflictOriginalPath(file.path);
    if (!originalPath) {
      continue;
    }

    const original = byPath.get(originalPath);
    conflicts.push({
      copyPath: file.path,
      originalPath,
      copySize: file.stat.size,
      originalSize: original?.stat.size ?? null,
      originalExists: original !== undefined,
      modifiedAt: file.stat.mtime,
    });
  }

  // Newest first: the most recent conflict is the one the user is most likely
  // acting on, and conflict copies accumulate over time.
  return conflicts.sort((left, right) => {
    if (left.modifiedAt !== right.modifiedAt) {
      return right.modifiedAt - left.modifiedAt;
    }
    return left.copyPath.localeCompare(right.copyPath);
  });
}