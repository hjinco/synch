import type { Plugin } from "obsidian";

import {
  shouldSyncVaultConfigPath,
  type VaultConfigSyncRules,
} from "../core/vault-config-rules";
import type { SyncVaultFile } from "./obsidian-vault-adapter";

export class ObsidianVaultConfigSource {
  constructor(
    private readonly plugin: Plugin,
    private readonly getVaultConfigSyncRules: () => VaultConfigSyncRules,
  ) {}

  isSyncablePath(path: string): boolean {
    return shouldSyncVaultConfigPath(
      path,
      this.getVaultConfigSyncRules(),
      this.configDir(),
    );
  }

  async listFiles(): Promise<SyncVaultFile[]> {
    const rules = this.getVaultConfigSyncRules();
    if (!rules.enabled) {
      return [];
    }

    const configDir = this.configDir();
    const stat = await this.plugin.app.vault.adapter.stat(configDir);
    if (!stat || stat.type !== "folder") {
      return [];
    }

    const files: SyncVaultFile[] = [];
    await this.collectFiles(configDir, files);
    return files;
  }

  private async collectFiles(
    folder: string,
    files: SyncVaultFile[],
  ): Promise<void> {
    const listed = await this.plugin.app.vault.adapter.list(folder);
    for (const childFolder of listed.folders) {
      await this.collectFiles(childFolder, files);
    }

    for (const filePath of listed.files) {
      if (!this.isSyncablePath(filePath)) {
        continue;
      }

      const stat = await this.plugin.app.vault.adapter.stat(filePath);
      if (!stat || stat.type !== "file") {
        continue;
      }

      files.push({
        path: filePath,
        mtime: stat.mtime,
        size: stat.size,
        readBytes: async () =>
          new Uint8Array(await this.plugin.app.vault.adapter.readBinary(filePath)),
      });
    }
  }

  private configDir(): string {
    return this.plugin.app.vault.configDir;
  }
}
