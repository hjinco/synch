import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getAvailableConflictCopyPath } from "@synch/sync-client/core";

import { isMissingPathError } from "./filesystem-errors";
import type { VaultPathResolver } from "./vault-path";

const OPERATIONS = ".synch/merge-writes";

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function unsupportedLink(error: unknown): boolean {
  return ["EXDEV", "ENOTSUP", "EOPNOTSUPP", "EPERM", "ENOSYS"].some((code) => hasCode(error, code));
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function sameFile(a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/** A successful hard link installs a complete file without replacing an editor's save. */
async function linkIfAbsent(source: string, destination: string): Promise<boolean> {
  try {
    await fs.link(source, destination);
    return true;
  } catch (error) {
    if (hasCode(error, "EEXIST")) return false;
    throw error;
  }
}

export class ConditionalTextWriter {
  private readonly unsupportedDirectories = new Set<string>();
  private readonly interrupted = new Set<string>();
  private scanned = false;
  private recovery: Promise<void> | null = null;

  constructor(private readonly paths: VaultPathResolver) {}

  supports(relativePath: string): boolean {
    return !this.unsupportedDirectories.has(path.posix.dirname(relativePath));
  }

  async write(relativePath: string, expected: string | Uint8Array, replacement: string): Promise<boolean> {
    await this.recover();
    const target = await this.paths.resolve(relativePath);
    const expectedBytes = typeof expected === "string" ? Buffer.from(expected) : expected;
    const expectedHash = digest(expectedBytes);
    try {
      if (!(await fs.lstat(target)).isFile() || !(await fs.readFile(target)).equals(expectedBytes)) return false;
    } catch (error) {
      if (isMissingPathError(error) || hasCode(error, "EISDIR")) return false;
      throw error;
    }

    const directory = await this.paths.resolve(OPERATIONS);
    await fs.mkdir(directory, { recursive: true });
    const createdAt = Date.now();
    const id = randomUUID();
    const operation = path.join(directory, id);
    await fs.mkdir(operation, { mode: 0o700 });
    const staged = path.join(operation, "replacement");
    const captured = path.join(operation, "source");
    let claimed = false;
    let installed = false;
    try {
      await fs.writeFile(staged, replacement, { flag: "wx" });
      // The placeholder also prevents rename from moving a directory here.
      // Recovery can distinguish it from a captured source by inode.
      try {
        await fs.link(staged, captured);
      } catch (error) {
        if (!unsupportedLink(error)) throw error;
        this.unsupportedDirectories.add(path.posix.dirname(relativePath));
        return false;
      }
      await fs.writeFile(path.join(operation, "intent"), JSON.stringify({
        path: relativePath, expectedHash, createdAt,
      }), { flag: "wx" });

      await this.paths.resolve(relativePath);
      try {
        await fs.rename(target, captured);
        claimed = true;
      } catch (error) {
        if (hasCode(error, "EXDEV")) {
          this.unsupportedDirectories.add(path.posix.dirname(relativePath));
          return false;
        }
        if (isMissingPathError(error) || hasCode(error, "EISDIR")) return false;
        throw error;
      }
      if (!(await fs.lstat(captured)).isFile() || !(await fs.readFile(captured)).equals(expectedBytes)) {
        return false;
      }

      installed = await linkIfAbsent(staged, target);
      // Removing the staging name records a completed install. If the user
      // deletes it before recovery, leave their deletion in place.
      if (installed) await fs.unlink(staged);
      return installed;
    } finally {
      try {
        if (claimed) await this.releaseSource(operation, createdAt, relativePath, expectedHash, installed);
        await this.removeOperation(operation);
      } catch (error) {
        this.interrupted.add(operation);
        throw error;
      }
    }
  }

  /** Called with the CLI vault lock held, before a scan can interpret the
   * temporarily missing source as a deletion. */
  recover(): Promise<void> {
    if (this.recovery) return this.recovery;
    if (this.scanned && !this.interrupted.size) return Promise.resolve();
    this.recovery = this.recoverOperations().finally(() => { this.recovery = null; });
    return this.recovery;
  }

  private async recoverOperations(): Promise<void> {
    // Every write passes this initial scan before creating its own staging
    // directory. Subsequent scans only touch operations whose writer exited.
    if (!this.scanned) {
      const directory = await this.paths.resolve(OPERATIONS);
      try {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          if (entry.isDirectory() && /^[\da-f-]{36}$/.test(entry.name)) {
            this.interrupted.add(path.join(directory, entry.name));
          }
        }
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
      }
      this.scanned = true;
    }
    for (const operation of this.interrupted) {
      const source = await fs.lstat(path.join(operation, "source"), { bigint: true }).catch((error: unknown) => {
        if (isMissingPathError(error)) return null;
        throw error;
      });
      const staged = source && await fs.lstat(path.join(operation, "replacement"), { bigint: true }).catch((error: unknown) => {
        if (isMissingPathError(error)) return null;
        throw error;
      });
      if (source && (!staged || !sameFile(source, staged))) {
        const intent: unknown = JSON.parse(await fs.readFile(path.join(operation, "intent"), "utf8"));
        if (!intent || typeof intent !== "object" || !("path" in intent) || typeof intent.path !== "string" ||
            !("expectedHash" in intent) || typeof intent.expectedHash !== "string" ||
            !("createdAt" in intent) || typeof intent.createdAt !== "number") {
          throw new Error(`Invalid merge recovery record at ${operation}.`);
        }
        await this.releaseSource(operation, intent.createdAt, intent.path, intent.expectedHash, staged === null);
      }
      await this.removeOperation(operation);
      this.interrupted.delete(operation);
    }
  }

  private async releaseSource(
    operation: string, createdAt: number, relativePath: string, expectedHash: string, installed: boolean,
  ): Promise<void> {
    const source = path.join(operation, "source");
    const parent = path.posix.dirname(relativePath);
    const parentPath = await this.paths.resolveIfAllowed(parent === "." ? "" : parent);
    const parentStat = parentPath && await fs.stat(parentPath).catch((error: unknown) => {
      if (isMissingPathError(error)) return null;
      throw error;
    });
    const target = parentPath && parentStat && parentStat.isDirectory()
      ? path.join(parentPath, path.basename(relativePath)) : null;
    // If another save won the destination, only discard the source we already
    // staged in the engine journal. Preserve any other displaced editor save.
    if (target && !installed && await linkIfAbsent(source, target)) return;
    const stat = await fs.lstat(source);
    if (target && stat.isFile() && digest(await fs.readFile(source)) === expectedHash) return;
    const sourceStat = await fs.lstat(source, { bigint: true });
    const targetStat = target && await fs.lstat(target, { bigint: true }).catch((error: unknown) => {
      if (isMissingPathError(error)) return null;
      throw error;
    });
    if (targetStat && sameFile(sourceStat, targetStat)) return;
    const beside = target ?? path.join(await this.paths.resolve(""), path.basename(relativePath));
    await getAvailableConflictCopyPath({
      exists: async (copy) => {
        if (await linkIfAbsent(source, copy)) return false;
        return !sameFile(sourceStat, await fs.lstat(copy, { bigint: true }));
      },
    }, beside, () => createdAt);
  }

  // Delete the captured source first, after it is recoverable. A crash during
  // cleanup then leaves only staging data, which recover() can discard.
  private async removeOperation(operation: string): Promise<void> {
    await fs.rm(path.join(operation, "source"), { force: true });
    await fs.rm(operation, { recursive: true, force: true });
  }
}
