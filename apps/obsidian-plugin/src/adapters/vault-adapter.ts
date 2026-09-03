import type { Plugin, TAbstractFile, TFile } from "obsidian";

import { toArrayBuffer } from "@synch/vault-crypto";
import type { SyncFileRules } from "@synch/sync-client/sync/core/file-rules";
import { isForbiddenVaultPath } from "@synch/sync-client/sync/core/vault-path-policy";
import type {
  SyncVaultAdapter,
  SyncVaultFile,
} from "@synch/sync-client/sync/vault/ports";
import { asSyncableFile, isSyncableVaultPath } from "./vault-files";

export class ObsidianSyncVaultAdapter implements SyncVaultAdapter {
  constructor(
    private readonly plugin: Plugin,
    private readonly getSyncFileRules: () => SyncFileRules,
  ) {}

  asSyncableFile(file: TAbstractFile): TFile | null {
    return asSyncableFile(file, this.getSyncFileRules(), this.configDir());
  }

  isSyncablePath(path: string): boolean {
    return isSyncableVaultPath(path, this.getSyncFileRules(), this.configDir());
  }

  isProtectedVaultPath(path: string): boolean {
    return isForbiddenVaultPath(path, this.configDir());
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

  async getFileSize(path: string): Promise<number> {
    const stat = await this.plugin.app.vault.adapter.stat(path);
    if (!stat || stat.type !== "file") {
      throw new Error(`Cannot stat vault file: ${path}`);
    }

    return stat.size;
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

  private configDir(): string {
    return this.plugin.app.vault.configDir;
  }
}
