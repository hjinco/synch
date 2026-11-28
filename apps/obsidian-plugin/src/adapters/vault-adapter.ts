import type { Plugin, TAbstractFile, TFile } from "obsidian";

import { toArrayBuffer } from "@synch/vault-crypto";
import { type SyncFileRules, isForbiddenVaultPath } from "@synch/sync-client/core";

import type {
  SyncVaultAdapter,
  SyncVaultFile,
} from "@synch/sync-client/vault";
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

  async statKind(path: string): Promise<"file" | "folder" | null> {
    try {
      return (await this.plugin.app.vault.adapter.stat(path))?.type ?? null;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error &&
          (error.code === "ENOENT" || error.code === "ENOTDIR")) return null;
      throw error;
    }
  }

  async exists(path: string): Promise<boolean> {
    return await this.plugin.app.vault.adapter.exists(path);
  }

  async areSameFilePaths(first: string, second: string): Promise<boolean> {
    if (first === second) return true;
    if (first.normalize("NFC").toLowerCase() !== second.normalize("NFC").toLowerCase()) return false;
    const adapter = this.plugin.app.vault.adapter;
    if (!await adapter.exists(first) || !await adapter.exists(second)) return false;
    const left = first.split("/");
    const right = second.split("/");
    for (let index = 0; index < left.length; index++) {
      if (left[index] === right[index]) continue;
      // Obsidian's sensitive check compares the basename in its parent directory.
      if (await adapter.exists(left.slice(0, index + 1).join("/"), true) &&
          await adapter.exists(right.slice(0, index + 1).join("/"), true)) return false;
    }
    return true;
  }

  async isOnlyChild(path: string): Promise<boolean> {
    const parts = path.split("/");
    parts.pop();
    const { files, folders } = await this.plugin.app.vault.adapter.list(parts.join("/"));
    return files.length + folders.length === 1 && (files[0] ?? folders[0]) === path;
  }

  async mkdir(path: string): Promise<void> {
    await this.plugin.app.vault.adapter.mkdir(path);
  }

  async writeText(path: string, content: string): Promise<void> {
    await this.plugin.app.vault.adapter.write(path, content);
  }

  canCompareTextForWrite(expected: string | Uint8Array): boolean {
    const text = typeof expected === "string" ? expected : new TextDecoder("utf-8", { ignoreBOM: true }).decode(expected);
    // process() decodes malformed bytes to U+FFFD, so it cannot distinguish
    // those bytes from a literal replacement character in a valid note.
    return !text.includes("\uFFFD");
  }

  async writeTextIfUnchanged(path: string, expected: string | Uint8Array, replacement: string): Promise<boolean> {
    const expectedText = typeof expected === "string" ? expected : new TextDecoder("utf-8", { ignoreBOM: true }).decode(expected);
    if (!this.canCompareTextForWrite(expectedText)) return false;
    const changed = new Error("Vault file changed during merge.");
    try {
      await this.plugin.app.vault.adapter.process(path, (current) => {
        if (current !== expectedText) throw changed;
        return replacement;
      });
      return true;
    } catch (error) {
      if (error === changed || await this.statKind(path) !== "file") return false;
      throw error;
    }
  }

  async writeBinary(path: string, content: Uint8Array): Promise<void> {
    await this.plugin.app.vault.adapter.writeBinary(path, toArrayBuffer(content));
  }

  async writeBytesIfAbsent(path: string, bytes: Uint8Array, operationId: string): Promise<boolean> {
    const adapter = this.plugin.app.vault.adapter;
    const scratch = this.stagedWritePath(operationId);
    try {
      await adapter.writeBinary(scratch, toArrayBuffer(bytes));
      try {
        // DataAdapter.copy fails if another writer already created the destination.
        await adapter.copy(scratch, path);
        return true;
      } catch (error) {
        // A failed copy may have created a partial destination. Only a
        // confirmed name collision lets the caller discard the write journal.
        if (typeof error === "object" && error !== null &&
            ("code" in error ? error.code === "EEXIST" :
              "message" in error && error.message === "Destination file already exists!")) return false;
        throw error;
      }
    } finally {
      await this.discardStagedWrite(operationId);
    }
  }

  async discardStagedWrite(operationId: string): Promise<void> {
    const path = this.stagedWritePath(operationId);
    if (await this.exists(path)) await this.plugin.app.vault.adapter.remove(path);
  }

  private stagedWritePath(operationId: string): string {
    const manifest = this.plugin.manifest;
    const dir = manifest.dir ?? `${this.configDir()}/plugins/${manifest.id}`;
    return `${dir}/.synch-write-${encodeURIComponent(operationId)}.tmp`;
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
