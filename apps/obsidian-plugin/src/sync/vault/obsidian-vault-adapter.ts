import type { Plugin, TAbstractFile, TFile } from "obsidian";

import type { SyncFileRules } from "../core/file-rules";
import type { VaultConfigSyncRules } from "../core/vault-config-rules";
import { isForbiddenVaultPath } from "../core/vault-path-policy";
import { asSyncableFile, isSyncableVaultPath, toArrayBuffer } from "./vault-files";

export interface SyncVaultFile {
  path: string;
  mtime: number;
  size: number;
  readBytes(): Promise<Uint8Array>;
}

export class ObsidianSyncVaultAdapter {
  constructor(
    private readonly plugin: Plugin,
    private readonly getSyncFileRules: () => SyncFileRules,
    private readonly getVaultConfigSyncRules: () => VaultConfigSyncRules,
  ) {}

  asSyncableFile(file: TAbstractFile): TFile | null {
    return asSyncableFile(file, this.getSyncFileRules());
  }

  isSyncablePath(path: string): boolean {
    return isSyncableVaultPath(path, this.getSyncFileRules());
  }

  isProtectedVaultPath(path: string): boolean {
    return isForbiddenVaultPath(path, this.getVaultConfigSyncRules());
  }

  async listFiles(): Promise<SyncVaultFile[]> {
    const byPath = new Map<string, SyncVaultFile>();
    const visibleFiles = this.plugin.app.vault
      .getFiles()
      .filter((file) => this.isSyncablePath(file.path));

    for (const file of visibleFiles) {
      byPath.set(file.path, {
        path: file.path,
        mtime: file.stat.mtime,
        size: file.stat.size,
        readBytes: async () => await this.readFile(file),
      });
    }

    for (const file of await this.listIncludedHiddenFiles()) {
      if (!byPath.has(file.path)) {
        byPath.set(file.path, file);
      }
    }

    return [...byPath.values()];
  }

  async readFile(file: TFile): Promise<Uint8Array> {
    return new Uint8Array(await this.plugin.app.vault.readBinary(file));
  }

  async readBytes(path: string): Promise<Uint8Array> {
    return new Uint8Array(await this.plugin.app.vault.adapter.readBinary(path));
  }

  async exists(path: string): Promise<boolean> {
    return await this.plugin.app.vault.adapter.exists(path);
  }

  async mkdir(path: string): Promise<void> {
    await this.plugin.app.vault.adapter.mkdir(path);
  }

  async writeText(path: string, content: string): Promise<void> {
    await this.plugin.app.vault.adapter.write(path, content);
  }

  async writeBinary(path: string, content: Uint8Array): Promise<void> {
    await this.plugin.app.vault.adapter.writeBinary(path, toArrayBuffer(content));
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.plugin.app.vault.adapter.rename(oldPath, newPath);
  }

  async remove(path: string): Promise<void> {
    await this.plugin.app.vault.adapter.remove(path);
  }

  private async listIncludedHiddenFiles(): Promise<SyncVaultFile[]> {
    const files: SyncVaultFile[] = [];
    for (const folder of this.getSyncFileRules().includedHiddenFolders) {
      const stat = await this.plugin.app.vault.adapter.stat(folder);
      if (!stat || stat.type !== "folder") {
        continue;
      }

      await this.collectHiddenFiles(folder, files);
    }
    return files;
  }

  private async collectHiddenFiles(
    folder: string,
    files: SyncVaultFile[],
  ): Promise<void> {
    const listed = await this.plugin.app.vault.adapter.list(folder);
    for (const childFolder of listed.folders) {
      if (this.isScannableFolder(childFolder)) {
        await this.collectHiddenFiles(childFolder, files);
      }
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
        readBytes: async () => await this.readBytes(filePath),
      });
    }
  }

  private isScannableFolder(path: string): boolean {
    return this.isSyncablePath(`${path}/__synch_probe__.md`);
  }
}
