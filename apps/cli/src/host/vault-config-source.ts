import { type VaultConfigSyncRules, shouldSyncVaultConfigPath } from "@synch/sync-client/core";

import type { SyncVaultConfigSource } from "@synch/sync-client/engine";
import type { SyncVaultFile } from "@synch/sync-client/vault";
import fs from "node:fs/promises";
import path from "node:path";

export interface NodeVaultConfigSourceDeps {
  vaultPath: string;
  getConfigDir: () => string;
  getVaultConfigSyncRules: () => VaultConfigSyncRules;
}

export class NodeVaultConfigSource implements SyncVaultConfigSource {
  constructor(private readonly deps: NodeVaultConfigSourceDeps) {}

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
    let entries;
    try {
      entries = await fs.readdir(this.absolutePath(folder), {
        withFileTypes: true,
      });
    } catch {
      return;
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

      const stat = await fs.stat(this.absolutePath(relativePath));
      files.push({
        path: relativePath,
        mtime: Math.floor(stat.mtimeMs),
        size: stat.size,
        readBytes: async () =>
          new Uint8Array(await fs.readFile(this.absolutePath(relativePath))),
      });
    }
  }

  private absolutePath(vaultRelativePath: string): string {
    return path.join(this.deps.vaultPath, ...vaultRelativePath.split("/"));
  }
}
