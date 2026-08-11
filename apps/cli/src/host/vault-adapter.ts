import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { SyncFileRules } from "@synch/sync-client/sync/core/file-rules";
import {
  isPathUnderFolders,
  normalizeVaultPath,
  pathHasHiddenSegment,
  shouldSyncPath,
} from "@synch/sync-client/sync/core/file-rules";
import { isNeverSyncReservedPath } from "@synch/sync-client/sync/core/reserved-paths";
import { isForbiddenVaultPath } from "@synch/sync-client/sync/core/vault-path-policy";
import type {
  SyncVaultAdapter,
  SyncVaultFile,
} from "@synch/sync-client/sync/vault/ports";

export interface NodeSyncVaultAdapterDeps {
  vaultPath: string;
  getConfigDir: () => string;
  getSyncFileRules: () => SyncFileRules;
}

/** Marker used for atomic write temp files; the change source ignores it. */
export const VAULT_TMP_FILE_MARKER = ".synch-tmp-";

export class NodeSyncVaultAdapter implements SyncVaultAdapter {
  constructor(private readonly deps: NodeSyncVaultAdapterDeps) {}

  isSyncablePath(vaultRelativePath: string): boolean {
    return shouldSyncPath(
      vaultRelativePath,
      this.deps.getSyncFileRules(),
      this.deps.getConfigDir(),
    );
  }

  isProtectedVaultPath(vaultRelativePath: string): boolean {
    return isForbiddenVaultPath(vaultRelativePath, this.deps.getConfigDir());
  }

  async listFiles(): Promise<SyncVaultFile[]> {
    const files: SyncVaultFile[] = [];
    await this.collectFiles("", files);
    return files;
  }

  async readBytes(vaultRelativePath: string): Promise<Uint8Array> {
    return new Uint8Array(await fs.readFile(this.absolutePath(vaultRelativePath)));
  }

  async statFile(
    vaultRelativePath: string,
  ): Promise<{ mtime: number; size: number } | null> {
    try {
      const stat = await fs.stat(this.absolutePath(vaultRelativePath));
      if (!stat.isFile()) {
        return null;
      }
      return { mtime: Math.floor(stat.mtimeMs), size: stat.size };
    } catch {
      return null;
    }
  }

  async exists(vaultRelativePath: string): Promise<boolean> {
    try {
      await fs.access(this.absolutePath(vaultRelativePath));
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(vaultRelativePath: string): Promise<void> {
    await fs.mkdir(this.absolutePath(vaultRelativePath), { recursive: true });
  }

  async writeText(vaultRelativePath: string, content: string): Promise<void> {
    await this.writeAtomic(vaultRelativePath, content);
  }

  async writeBinary(vaultRelativePath: string, content: Uint8Array): Promise<void> {
    await this.writeAtomic(vaultRelativePath, content);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await fs.rename(this.absolutePath(oldPath), this.absolutePath(newPath));
  }

  async remove(vaultRelativePath: string): Promise<void> {
    const absolute = this.absolutePath(vaultRelativePath);
    const stat = await fs.lstat(absolute);
    if (stat.isDirectory()) {
      await fs.rmdir(absolute);
      return;
    }

    await fs.unlink(absolute);
  }

  private async collectFiles(folder: string, files: SyncVaultFile[]): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(this.absolutePath(folder), {
        withFileTypes: true,
      });
    } catch {
      return;
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

      const stat = await this.statFile(relativePath);
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

  private async writeAtomic(
    vaultRelativePath: string,
    content: string | Uint8Array,
  ): Promise<void> {
    const absolute = this.absolutePath(vaultRelativePath);
    const tempPath = path.join(
      path.dirname(absolute),
      `${VAULT_TMP_FILE_MARKER}${randomBytes(6).toString("hex")}`,
    );
    try {
      await fs.writeFile(tempPath, content);
      await fs.rename(tempPath, absolute);
    } catch (error) {
      await fs.unlink(tempPath).catch(() => {});
      throw error;
    }
  }

  private absolutePath(vaultRelativePath: string): string {
    const normalized = normalizeVaultPath(vaultRelativePath);
    if (
      normalized.split("/").some((segment) => segment === "." || segment === "..")
    ) {
      throw new Error(`Unsafe vault path: ${vaultRelativePath}`);
    }

    return normalized
      ? path.join(this.deps.vaultPath, ...normalized.split("/"))
      : this.deps.vaultPath;
  }
}
