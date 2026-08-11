import type { Plugin } from "obsidian";

export function createTestPlugin(): Plugin {
  let data: unknown = null;
  const localStorage = new Map<string, unknown>();
  const directories = new Set([".obsidian/plugins/synch"]);
  const files = new Map<string, string | Uint8Array>();

  return {
    manifest: {
      dir: ".obsidian/plugins/synch",
    },
    app: {
      loadLocalStorage(key: string): unknown | null {
        return localStorage.get(key) ?? null;
      },
      saveLocalStorage(key: string, value: unknown | null): void {
        if (value === null) {
          localStorage.delete(key);
          return;
        }

        localStorage.set(key, value);
      },
      vault: {
        configDir: ".obsidian",
        getFiles(): [] {
          return [];
        },
        adapter: {
          async exists(path: string): Promise<boolean> {
            return directories.has(path) || files.has(path);
          },
          async stat(path: string): Promise<{
            type: "file" | "folder";
            ctime: number;
            mtime: number;
            size: number;
          } | null> {
            const file = files.get(path);
            if (file !== undefined) {
              return {
                type: "file",
                ctime: 1,
                mtime: 1,
                size: typeof file === "string" ? file.length : file.byteLength,
              };
            }

            if (directories.has(path)) {
              return {
                type: "folder",
                ctime: 1,
                mtime: 1,
                size: 0,
              };
            }

            return null;
          },
          async list(path: string): Promise<{ files: string[]; folders: string[] }> {
            const prefix = path ? `${path}/` : "";
            const childFiles = new Set<string>();
            const childFolders = new Set<string>();

            for (const filePath of files.keys()) {
              if (!filePath.startsWith(prefix)) {
                continue;
              }

              const rest = filePath.slice(prefix.length);
              const slashIndex = rest.indexOf("/");
              if (slashIndex < 0) {
                childFiles.add(filePath);
              } else {
                childFolders.add(`${prefix}${rest.slice(0, slashIndex)}`);
              }
            }

            for (const folderPath of directories) {
              if (folderPath === path || !folderPath.startsWith(prefix)) {
                continue;
              }

              const rest = folderPath.slice(prefix.length);
              const slashIndex = rest.indexOf("/");
              childFolders.add(
                slashIndex < 0
                  ? folderPath
                  : `${prefix}${rest.slice(0, slashIndex)}`,
              );
            }

            return {
              files: [...childFiles].sort((left, right) => left.localeCompare(right)),
              folders: [...childFolders].sort((left, right) => left.localeCompare(right)),
            };
          },
          async read(path: string): Promise<string> {
            const file = files.get(path);
            if (typeof file !== "string") {
              throw new Error(`missing test file: ${path}`);
            }

            return file;
          },
          async readBinary(path: string): Promise<ArrayBuffer> {
            const file = files.get(path);
            if (!(file instanceof Uint8Array)) {
              throw new Error(`missing test file: ${path}`);
            }

            return file.slice().buffer;
          },
          async write(path: string, value: string): Promise<void> {
            files.set(path, value);
          },
          async writeBinary(path: string, value: ArrayBuffer): Promise<void> {
            files.set(path, new Uint8Array(value));
          },
          async rename(oldPath: string, newPath: string): Promise<void> {
            const value = files.get(oldPath);
            if (value === undefined) {
              throw new Error(`missing test file: ${oldPath}`);
            }
            files.delete(oldPath);
            files.set(newPath, value);
          },
          async remove(path: string): Promise<void> {
            files.delete(path);
          },
          async mkdir(path: string): Promise<void> {
            directories.add(path);
          },
        },
      },
    },
    async loadData(): Promise<unknown> {
      return data;
    },
    async saveData(value: unknown): Promise<void> {
      data = value;
    },
  } as unknown as Plugin;
}
