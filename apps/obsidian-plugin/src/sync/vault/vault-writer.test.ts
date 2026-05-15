import { describe, expect, it } from "vitest";

import {
  removeVaultPathIfExists,
  writeVaultBinary,
  writeVaultBytes,
  writeVaultText,
  type SyncVaultWriter,
} from "./vault-writer";

describe("vault writer", () => {
  it("creates parent directories and writes markdown as text", async () => {
    const writer = new MemoryVaultWriter();

    await writeVaultBytes(writer, "Folder/Nested/note.md", new TextEncoder().encode("hello"));

    expect(writer.directories).toEqual(new Set(["Folder", "Folder/Nested"]));
    expect(writer.textFiles.get("Folder/Nested/note.md")).toBe("hello");
    expect(writer.binaryFiles.has("Folder/Nested/note.md")).toBe(false);
  });

  it("writes non-markdown bytes as binary", async () => {
    const writer = new MemoryVaultWriter();
    const bytes = new Uint8Array([1, 2, 3]);

    await writeVaultBytes(writer, "Assets/image.png", bytes);

    expect(writer.directories).toEqual(new Set(["Assets"]));
    expect(writer.binaryFiles.get("Assets/image.png")).toEqual(bytes);
    expect(writer.textFiles.has("Assets/image.png")).toBe(false);
  });

  it("supports explicit text, binary, and remove-if-exists operations", async () => {
    const writer = new MemoryVaultWriter();

    await writeVaultText(writer, "Meta/manifest.json", "{}");
    await writeVaultBinary(writer, "Backup/file.bin", new Uint8Array([9]));

    expect(await removeVaultPathIfExists(writer, "Meta/manifest.json")).toBe(true);
    expect(await removeVaultPathIfExists(writer, "missing.md")).toBe(false);
    expect(writer.textFiles.has("Meta/manifest.json")).toBe(false);
    expect(writer.binaryFiles.get("Backup/file.bin")).toEqual(new Uint8Array([9]));
  });

  it("refuses to modify reserved vault paths", async () => {
    const writer = new MemoryVaultWriter();

    await expect(writeVaultText(writer, ".obsidian/app.json", "{}")).rejects.toThrow(
      "Refusing to modify reserved vault path",
    );
    expect(writer.directories.has(".obsidian")).toBe(false);
  });
});

class MemoryVaultWriter implements SyncVaultWriter {
  readonly directories = new Set<string>();
  readonly textFiles = new Map<string, string>();
  readonly binaryFiles = new Map<string, Uint8Array>();

  async exists(path: string): Promise<boolean> {
    return (
      this.directories.has(path) ||
      this.textFiles.has(path) ||
      this.binaryFiles.has(path)
    );
  }

  async mkdir(path: string): Promise<void> {
    this.directories.add(path);
  }

  async writeText(path: string, content: string): Promise<void> {
    this.textFiles.set(path, content);
  }

  async writeBinary(path: string, content: Uint8Array): Promise<void> {
    this.binaryFiles.set(path, content);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const text = this.textFiles.get(oldPath);
    if (text !== undefined) {
      this.textFiles.delete(oldPath);
      this.textFiles.set(newPath, text);
      return;
    }

    const binary = this.binaryFiles.get(oldPath);
    if (binary !== undefined) {
      this.binaryFiles.delete(oldPath);
      this.binaryFiles.set(newPath, binary);
    }
  }

  async remove(path: string): Promise<void> {
    this.textFiles.delete(path);
    this.binaryFiles.delete(path);
  }
}
