import fs from "node:fs/promises";

import {
  type VaultConfigSyncRules,
  shouldSyncVaultConfigPath,
} from "@synch/sync-client/core";
import type { SyncVaultConfigSource } from "@synch/sync-client/engine";
import type { SyncVaultFile } from "@synch/sync-client/vault";
import { VaultPathResolver } from "./vault-path";
import { isMissingPathError } from "./filesystem-errors";

export interface NodeVaultConfigSourceDeps {
  vaultPath: string;
  getConfigDir: () => string;
  getVaultConfigSyncRules: () => VaultConfigSyncRules;
}

export class NodeVaultConfigSource implements SyncVaultConfigSource {
  private readonly paths: VaultPathResolver;

  constructor(private readonly deps: NodeVaultConfigSourceDeps) {
    this.paths = new VaultPathResolver(deps.vaultPath);
  }

  isSyncablePath(vaultRelativePath: string): boolean {
    return shouldSyncVaultConfigPath(
      vaultRelativePath,
      this.deps.getVaultConfigSyncRules(),
      this.deps.getConfigDir(),
    );
  }

  async listFiles(): Promise<SyncVaultFile[]> {
    if (!this.deps.getVaultConfigSyncRules().enabled) {
      return [];
    }

    const files: SyncVaultFile[] = [];
    await this.collectFiles(this.deps.getConfigDir(), files);
    return files;
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
      // Missing config directories are normal; unreadable ones are not empty.
      if (isMissingPathError(error)) return;
      throw error;
    }

    for (const entry of entries) {
      const relativePath = `${folder}/${entry.name}`;
      if (entry.isDirectory()) {
        await this.collectFiles(relativePath, files);
        continue;
      }

      if (!entry.isFile() || !this.isSyncablePath(relativePath)) {
        continue;
      }

      const absoluteFile = await this.paths.resolveIfAllowed(relativePath);
      if (absoluteFile === null) continue;
      const stat = await fs.stat(absoluteFile);
      files.push({
        path: relativePath,
        mtime: Math.floor(stat.mtimeMs),
        size: stat.size,
        readBytes: async () => {
          const absolute = await this.paths.resolve(relativePath);
          return new Uint8Array(await fs.readFile(absolute));
        },
      });
    }
  }
}
