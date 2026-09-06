import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { SyncVaultAdapter, SyncVaultFile } from "@synch/sync-client/vault";

/** Ordinary filesystem mutations, with no overlay or retained file contents. */
export class FilesystemVault implements SyncVaultAdapter {
  constructor(readonly directory: string) {}
  private path(path: string) {
    const root = resolve(this.directory), result = resolve(root, path);
    if (!result.startsWith(root + sep)) throw new Error(`Unsafe vault path: ${path}`);
    return result;
  }
  async readBytes(path: string) { return new Uint8Array(await readFile(this.path(path))); }
  async getFileSize(path: string) { return (await stat(this.path(path))).size; }
  async exists(path: string) {
    try { await stat(this.path(path)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  async mkdir(path: string) { await mkdir(this.path(path), { recursive: true }); }
  async writeBinary(path: string, bytes: Uint8Array) {
    await mkdir(dirname(this.path(path)), { recursive: true });
    await writeFile(this.path(path), bytes);
  }
  async writeText(path: string, text: string) { await this.writeBinary(path, new TextEncoder().encode(text)); }
  async remove(path: string) { await rm(this.path(path), { force: true }); }
  async rename(from: string, to: string) {
    await mkdir(dirname(this.path(to)), { recursive: true });
    await rename(this.path(from), this.path(to));
  }
  async listFiles(): Promise<SyncVaultFile[]> {
    const files: SyncVaultFile[] = [];
    const walk = async (prefix: string) => {
      for (const entry of await readdir(prefix ? this.path(prefix) : this.directory, { withFileTypes: true })) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile()) {
          const info = await stat(this.path(path));
          files.push({ path, size: info.size, mtime: info.mtimeMs, readBytes: () => this.readBytes(path) });
        }
      }
    };
    await walk("");
    return files;
  }
}
