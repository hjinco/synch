import type { SyncVaultAdapter, SyncVaultFile } from "../sync/vault/ports";

interface InMemoryVaultEntry {
  bytes: Uint8Array;
  mtime: number;
}

export class InMemoryVaultAdapter implements SyncVaultAdapter {
  private readonly files = new Map<string, InMemoryVaultEntry>();
  private readonly directories = new Set<string>();
  private writeClock = 0;

  seedFile(path: string, bytes: Uint8Array, mtime = 1): void {
    this.files.set(path, { bytes: copyBytes(bytes), mtime });
  }

  seedText(path: string, content: string, mtime = 1): void {
    this.seedFile(path, new TextEncoder().encode(content), mtime);
  }

  seedDirectory(path: string): void {
    this.directories.add(path);
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const entry = this.files.get(path);
    if (!entry) {
      throw new Error(`missing test file: ${path}`);
    }

    return copyBytes(entry.bytes);
  }

  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readBytes(path));
  }

  async listFiles(): Promise<SyncVaultFile[]> {
    return this.listFilesUnder("");
  }

  async listFilesUnder(prefix: string): Promise<SyncVaultFile[]> {
    const files: SyncVaultFile[] = [];
    for (const [path, entry] of this.files) {
      if (prefix && !path.startsWith(prefix)) {
        continue;
      }

      files.push({
        path,
        mtime: entry.mtime,
        size: entry.bytes.byteLength,
        readBytes: async () => await this.readBytes(path),
      });
    }

    return files;
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.directories.has(path);
  }

  async mkdir(path: string): Promise<void> {
    this.directories.add(path);
  }

  async writeText(path: string, content: string): Promise<void> {
    this.write(path, new TextEncoder().encode(content));
  }

  async writeBinary(path: string, content: Uint8Array): Promise<void> {
    this.write(path, content);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const entry = this.files.get(oldPath);
    if (!entry) {
      throw new Error(`missing test file: ${oldPath}`);
    }

    this.files.delete(oldPath);
    this.files.set(newPath, entry);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  private write(path: string, bytes: Uint8Array): void {
    this.writeClock += 1;
    this.files.set(path, { bytes: copyBytes(bytes), mtime: this.writeClock });
  }
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}
