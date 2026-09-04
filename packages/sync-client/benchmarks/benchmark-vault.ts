import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

import type { SyncVaultAdapter, SyncVaultFile } from "../src/index";

export async function createBenchmarkVault(sourceDirectory: string | null): Promise<{
  adapter: SyncVaultAdapter;
  dispose(): Promise<void>;
}> {
  const overlayDirectory = await mkdtemp(join(tmpdir(), "synch-sync-client-vault-"));
  return {
    adapter: new BenchmarkVaultAdapter(sourceDirectory, overlayDirectory),
    dispose: async () => {
      await rm(overlayDirectory, { recursive: true, force: true });
    },
  };
}

class BenchmarkVaultAdapter implements SyncVaultAdapter {
  private readonly deletedPaths = new Set<string>();

  constructor(
    private readonly sourceDirectory: string | null,
    private readonly overlayDirectory: string,
  ) {}

  async readBytes(path: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(await this.readablePath(path)));
  }

  async getFileSize(path: string): Promise<number> {
    return (await stat(await this.readablePath(path))).size;
  }

  async listFiles(): Promise<SyncVaultFile[]> {
    const paths = new Map<string, string>();
    if (this.sourceDirectory) {
      await this.collectFiles(this.sourceDirectory, this.sourceDirectory, paths);
    }
    await this.collectFiles(this.overlayDirectory, this.overlayDirectory, paths);

    return await Promise.all(
      [...paths.entries()]
        .filter(([path]) => !this.deletedPaths.has(path))
        .map(async ([path, filePath]) => {
          const file = await stat(filePath);
          return {
            path,
            mtime: file.mtimeMs,
            size: file.size,
            readBytes: async () => await this.readBytes(path),
          } satisfies SyncVaultFile;
        }),
    );
  }

  async exists(path: string): Promise<boolean> {
    if (this.deletedPaths.has(path)) return false;
    return await this.pathExists(this.overlayPath(path)) ||
      (this.sourceDirectory ? await this.pathExists(this.sourcePath(path)) : false);
  }

  async mkdir(path: string): Promise<void> {
    await mkdir(this.overlayPath(path), { recursive: true });
  }

  async writeText(path: string, content: string): Promise<void> {
    await this.write(path, new TextEncoder().encode(content));
  }

  async writeBinary(path: string, content: Uint8Array): Promise<void> {
    await this.write(path, content);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    if (await this.pathExists(this.overlayPath(oldPath))) {
      await mkdir(dirname(this.overlayPath(newPath)), { recursive: true });
      await rename(this.overlayPath(oldPath), this.overlayPath(newPath));
    } else {
      await this.write(newPath, await this.readBytes(oldPath));
    }
    this.deletedPaths.add(oldPath);
  }

  async remove(path: string): Promise<void> {
    this.deletedPaths.add(path);
    await rm(this.overlayPath(path), { force: true });
  }

  private async write(path: string, bytes: Uint8Array): Promise<void> {
    this.deletedPaths.delete(path);
    const filePath = this.overlayPath(path);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, bytes);
  }

  private async readablePath(path: string): Promise<string> {
    const overlayPath = this.overlayPath(path);
    if (!this.deletedPaths.has(path) && (await this.pathExists(overlayPath))) {
      return overlayPath;
    }
    if (this.sourceDirectory && !this.deletedPaths.has(path)) {
      const sourcePath = this.sourcePath(path);
      if (await this.pathExists(sourcePath)) return sourcePath;
    }
    throw new Error(`benchmark vault file does not exist: ${path}`);
  }

  private async collectFiles(
    rootDirectory: string,
    directory: string,
    paths: Map<string, string>,
  ): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await this.collectFiles(rootDirectory, filePath, paths);
        continue;
      }
      if (!entry.isFile()) continue;
      const vaultPath = relative(rootDirectory, filePath).split(sep).join("/");
      paths.set(vaultPath, filePath);
    }
  }

  private overlayPath(path: string): string {
    return safeJoin(this.overlayDirectory, path);
  }

  private sourcePath(path: string): string {
    if (!this.sourceDirectory) {
      throw new Error("benchmark vault has no source directory");
    }
    return safeJoin(this.sourceDirectory, path);
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if (isMissingFileError(error)) return false;
      throw error;
    }
  }
}

function safeJoin(rootDirectory: string, vaultPath: string): string {
  const root = resolve(rootDirectory);
  const result = resolve(rootDirectory, vaultPath);
  if (result !== root && !result.startsWith(`${root}${sep}`)) {
    throw new Error(`unsafe benchmark vault path: ${vaultPath}`);
  }
  return result;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
