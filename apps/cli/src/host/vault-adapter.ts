import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  type SyncFileRules,
  isPathUnderFolders,
  normalizeVaultPath,
  pathHasHiddenSegment,
  shouldSyncPath,
  isNeverSyncReservedPath,
  isForbiddenVaultPath,
} from "@synch/sync-client/core";

import type {
  SyncVaultAdapter,
  SyncVaultFile,
} from "@synch/sync-client/vault";
import { ConditionalTextWriter } from "./conditional-text-write";
import { VaultPathResolver } from "./vault-path";
import { isMissingPathError } from "./filesystem-errors";

export interface NodeSyncVaultAdapterDeps {
  vaultPath: string;
  getConfigDir: () => string;
  getSyncFileRules: () => SyncFileRules;
}

/** Marker used for atomic write temp files; the change source ignores it. */
export const VAULT_TMP_FILE_MARKER = ".synch-tmp-";

export class NodeSyncVaultAdapter implements SyncVaultAdapter {
  readonly atomicWrites = true;
  private readonly paths: VaultPathResolver;
  private readonly conditionalWriter: ConditionalTextWriter;

  constructor(private readonly deps: NodeSyncVaultAdapterDeps) {
    this.paths = new VaultPathResolver(deps.vaultPath);
    this.conditionalWriter = new ConditionalTextWriter(this.paths);
  }

  isSyncablePath(vaultRelativePath: string): boolean {
    return shouldSyncPath(
      vaultRelativePath,
      this.deps.getSyncFileRules(),
      this.deps.getConfigDir(),
    );
  }

  async isExcludedPath(vaultRelativePath: string): Promise<boolean> {
    return await this.paths.isExcluded(vaultRelativePath);
  }

  isProtectedVaultPath(vaultRelativePath: string): boolean {
    return isForbiddenVaultPath(vaultRelativePath, this.deps.getConfigDir());
  }

  async areSameFilePaths(first: string, second: string): Promise<boolean> {
    const canonical = async (name: string) => {
      const allowed = await this.paths.resolveIfAllowed(name);
      return allowed === null ? null : await fs.realpath(allowed);
    };
    try {
      const [source, destination] = await Promise.all([canonical(first), canonical(second)]);
      return source !== null && source === destination;
    } catch (error) {
      if (isMissingPathError(error)) return false;
      throw error;
    }
  }

  async isOnlyChild(name: string): Promise<boolean> {
    const file = await this.paths.resolve(name);
    const siblings = await fs.readdir(path.dirname(file));
    return siblings.length === 1 && siblings[0] === path.basename(await fs.realpath(file));
  }

  async listFiles(): Promise<SyncVaultFile[]> {
    const files: SyncVaultFile[] = [];
    await this.collectFiles("", files);
    return files;
  }

  async readBytes(vaultRelativePath: string): Promise<Uint8Array> {
    const absolute = await this.paths.resolve(vaultRelativePath);
    return new Uint8Array(await fs.readFile(absolute));
  }

  async getFileSize(vaultRelativePath: string): Promise<number> {
    const stat = await fs.stat(await this.paths.resolve(vaultRelativePath));
    if (!stat.isFile()) {
      throw new Error(`Cannot stat vault file: ${vaultRelativePath}`);
    }

    return stat.size;
  }

  async statKind(vaultRelativePath: string): Promise<"file" | "folder" | null> {
    const absolute = await this.paths.resolve(vaultRelativePath);
    try {
      const stat = await fs.stat(absolute);
      return stat.isFile() ? "file" : "folder";
    } catch (error) {
      if (isMissingPathError(error)) return null;
      throw error;
    }
  }

  async statFile(
    vaultRelativePath: string,
  ): Promise<{ mtime: number; size: number } | null> {
    return await this.statAbsoluteFile(await this.paths.resolve(vaultRelativePath));
  }

  private async statAbsoluteFile(
    absolute: string,
  ): Promise<{ mtime: number; size: number } | null> {
    try {
      const stat = await fs.stat(absolute);
      if (!stat.isFile()) {
        return null;
      }
      return { mtime: Math.floor(stat.mtimeMs), size: stat.size };
    } catch (error) {
      if (isMissingPathError(error)) return null;
      throw error;
    }
  }

  async exists(vaultRelativePath: string): Promise<boolean> {
    const absolute = await this.paths.resolve(vaultRelativePath);
    try {
      await fs.access(absolute);
      return true;
    } catch (error) {
      if (isMissingPathError(error)) return false;
      throw error;
    }
  }

  async mkdir(vaultRelativePath: string): Promise<void> {
    await fs.mkdir(await this.paths.resolve(vaultRelativePath), { recursive: true });
  }

  async writeText(vaultRelativePath: string, content: string): Promise<void> {
    await this.writeStaged(vaultRelativePath, content, "replace");
  }

  async writeBinary(vaultRelativePath: string, content: Uint8Array): Promise<void> {
    await this.writeStaged(vaultRelativePath, content, "replace");
  }

  async writeBytesIfAbsent(vaultRelativePath: string, content: Uint8Array): Promise<boolean> {
    return await this.writeStaged(vaultRelativePath, content, "create");
  }

  canCompareTextForWrite(_expected: string | Uint8Array, path: string): boolean {
    return this.conditionalWriter.supports(path);
  }

  async writeTextIfUnchanged(vaultRelativePath: string, expected: string | Uint8Array, replacement: string): Promise<boolean> {
    return await this.conditionalWriter.write(vaultRelativePath, expected, replacement);
  }

  async recoverInterruptedWrites(): Promise<void> {
    await this.conditionalWriter.recover();
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const source = await this.paths.resolve(oldPath);
    const destination = await this.paths.resolve(newPath);
    await fs.rename(source, destination);
  }

  async remove(vaultRelativePath: string): Promise<void> {
    const absolute = await this.paths.resolve(vaultRelativePath);
    const stat = await fs.lstat(absolute);
    if (stat.isDirectory()) {
      await fs.rmdir(absolute);
      return;
    }

    await fs.unlink(absolute);
  }

  private async collectFiles(folder: string, files: SyncVaultFile[]): Promise<void> {
    const absolute = await this.paths.resolveIfAllowed(folder);
    if (absolute === null) return;
    let entries;
    try {
      entries = await fs.readdir(absolute, {
        withFileTypes: true,
      });
    } catch (error) {
      // A descendant may disappear during traversal, but an unavailable root
      // or an incomplete scan must never be interpreted as local deletions.
      if (folder && isMissingPathError(error)) return;
      throw error;
    }

    for (const entry of entries) {
      const relativePath = folder ? `${folder}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (this.shouldScanFolder(relativePath)) {
          await this.collectFiles(relativePath, files);
        }
        continue;
      }

      if (!entry.isFile() || !this.isSyncablePath(relativePath)) {
        continue;
      }

      const absoluteFile = await this.paths.resolveIfAllowed(relativePath);
      if (absoluteFile === null) continue;
      const stat = await this.statAbsoluteFile(absoluteFile);
      if (!stat) {
        continue;
      }

      files.push({
        path: relativePath,
        mtime: stat.mtime,
        size: stat.size,
        readBytes: async () => await this.readBytes(relativePath),
      });
    }
  }

  private shouldScanFolder(relativePath: string): boolean {
    if (isNeverSyncReservedPath(relativePath)) {
      return false;
    }

    const configDir = normalizeVaultPath(this.deps.getConfigDir());
    if (
      configDir &&
      (relativePath === configDir || relativePath.startsWith(`${configDir}/`))
    ) {
      // Vault config files are scanned by the vault config source instead.
      return false;
    }

    if (!pathHasHiddenSegment(relativePath)) {
      return true;
    }

    // Scan hidden folders only when they contain (or are contained by) an
    // explicitly included hidden folder.
    const included = this.deps.getSyncFileRules().includedHiddenFolders;
    return (
      isPathUnderFolders(relativePath, included) ||
      included.some((folder) => folder.startsWith(`${relativePath}/`))
    );
  }

  private async writeStaged(
    vaultRelativePath: string,
    content: string | Uint8Array,
    mode: "create" | "replace",
  ): Promise<boolean> {
    const absolute = await this.paths.resolve(vaultRelativePath);
    const tempPath = path.join(
      path.dirname(absolute),
      `${VAULT_TMP_FILE_MARKER}${randomBytes(6).toString("hex")}`,
    );
    // Exclusive creation cannot follow a pre-existing temp-file symlink. Only
    // clean up a temp file that this operation successfully created.
    const temp = await fs.open(tempPath, "wx");
    let renamed = false;
    try {
      await temp.writeFile(content);
      await temp.close();
      await this.paths.resolve(vaultRelativePath);
      if (mode === "replace") {
        await fs.rename(tempPath, absolute);
        renamed = true;
        return true;
      }
      try {
        await fs.copyFile(tempPath, absolute, fs.constants.COPYFILE_EXCL);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
        throw error;
      }
      return true;
    } finally {
      if (!renamed) {
        await temp.close().catch(() => {});
        await fs.unlink(tempPath).catch(() => {});
      }
    }
  }
}
