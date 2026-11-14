import fs from "node:fs/promises";
import path from "node:path";

import { normalizeVaultPath } from "@synch/sync-client/core";

export class UnsafeVaultPathError extends Error {}

/**
 * Resolve sync paths without following links below the selected vault root.
 * Only the canonical root is cached: every operation checks existing components,
 * including dangling links and the final component, before touching the path.
 *
 * These checks protect against existing links, not a hostile local process that
 * swaps directories between validation and I/O. That requires OS-level
 * descriptor-relative operations, which Node's portable fs API does not expose.
 */
export class VaultPathResolver {
  private root: Promise<string> | undefined;

  constructor(private readonly vaultPath: string) {}

  async isExcluded(vaultRelativePath: string): Promise<boolean> {
    try {
      await this.resolve(vaultRelativePath);
      return false;
    } catch (error) {
      if (error instanceof UnsafeVaultPathError) return true;
      throw error;
    }
  }

  async resolve(vaultRelativePath: string): Promise<string> {
    const normalized = normalizeVaultPath(vaultRelativePath);
    if (
      path.posix.isAbsolute(vaultRelativePath.trim()) ||
      path.win32.isAbsolute(vaultRelativePath.trim()) ||
      /[\\\0:]/.test(normalized) ||
      normalized
        .split("/")
        .some((segment) => segment === "." || segment === "..")
    ) {
      throw new UnsafeVaultPathError(`Unsafe vault path: ${vaultRelativePath}`);
    }

    this.root ??= fs.realpath(this.vaultPath);
    const root = await this.root;
    const segments = normalized ? normalized.split("/").filter(Boolean) : [];
    let current = root;
    // Check the root too, in case it was replaced after canonicalization.
    for (let index = 0; index <= segments.length; index++) {
      if (index > 0) current = path.join(current, segments[index - 1]!);
      let stat;
      try {
        stat = await fs.lstat(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && index > 0) {
          // A new path is allowed, but all of its existing ancestors were checked.
          break;
        }
        throw error;
      }
      if (stat.isSymbolicLink()) {
        if (index === 0)
          throw new Error(
            "The canonical vault root was replaced by a symlink.",
          );
        throw new UnsafeVaultPathError(
          `Unsafe vault path: ${vaultRelativePath} (symlink: ${current})`,
        );
      }
    }
    return path.join(root, ...segments);
  }
}
