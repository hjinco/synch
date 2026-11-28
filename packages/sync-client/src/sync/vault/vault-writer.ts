import { decodeUtf8 } from "../core/content";
import { isNeverSyncReservedPath } from "../core/reserved-paths";
import type { SyncVaultAccess } from "./ports";

export interface SyncVaultWriter {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  writeText(path: string, content: string): Promise<void>;
  writeBinary(path: string, content: Uint8Array): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  remove(path: string): Promise<void>;
  isProtectedVaultPath?(path: string): boolean;
}

export async function writeVaultBytes(
  writer: Pick<
    SyncVaultWriter,
    "exists" | "mkdir" | "writeText" | "writeBinary" | "isProtectedVaultPath"
  >,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  assertWritableVaultPath(writer, path);
  await ensureParentDirectories(writer, path);
  if (isMarkdownPath(path)) {
    const text = decodeUtf8(bytes);
    if (text !== null) {
      await writer.writeText(path, text);
      return;
    }
  }

  await writer.writeBinary(path, bytes);
}

/** Install a prepared Markdown merge only while its source still owns the path. */
export async function replaceVaultTextIfUnchanged(
  vault: SyncVaultAccess,
  path: string,
  expected: string | Uint8Array,
  mergedBytes: Uint8Array,
): Promise<boolean> {
  assertWritableVaultPath(vault, path);
  const replacement = decodeUtf8(mergedBytes);
  if (replacement === null) throw new Error("A prepared text merge must be valid UTF-8.");
  if (vault.writeTextIfUnchanged) {
    return await vault.writeTextIfUnchanged(path, expected, replacement);
  }
  if (!await vault.exists(path)) return false;
  const current = await vault.readBytes(path);
  const matches = typeof expected === "string" ? decodeUtf8(current) === expected :
    expected.length === current.length && expected.every((byte, index) => byte === current[index]);
  if (!matches) return false;
  await vault.writeText(path, replacement);
  return true;
}

export async function writeVaultBinary(
  writer: Pick<
    SyncVaultWriter,
    "exists" | "mkdir" | "writeBinary" | "isProtectedVaultPath"
  >,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  assertWritableVaultPath(writer, path);
  await ensureParentDirectories(writer, path);
  await writer.writeBinary(path, bytes);
}

export async function writeVaultBinaryIfAbsent(
  vault: SyncVaultAccess, path: string, bytes: Uint8Array, operationId: string,
): Promise<boolean> {
  assertWritableVaultPath(vault, path);
  await ensureParentDirectories(vault, path);
  if (vault.writeBytesIfAbsent) return await vault.writeBytesIfAbsent(path, bytes, operationId);
  if (await vault.exists(path)) return false;
  await vault.writeBinary(path, bytes);
  return true;
}

export async function renameVaultPath(
  writer: Pick<
    SyncVaultWriter,
    "exists" | "mkdir" | "rename" | "isProtectedVaultPath"
  >,
  oldPath: string,
  newPath: string,
): Promise<void> {
  assertWritableVaultPath(writer, oldPath);
  assertWritableVaultPath(writer, newPath);
  await ensureParentDirectories(writer, newPath);
  await writer.rename(oldPath, newPath);
}

/** Both paths already name the same physical file. Change the spelling without
 * unlinking it, or implicitly changing the paths of a directory's siblings. */
export async function renameAliasedVaultPath(
  vault: SyncVaultAccess, oldPath: string, newPath: string,
): Promise<string> {
  assertWritableVaultPath(vault, oldPath);
  assertWritableVaultPath(vault, newPath);
  const source = oldPath.split("/");
  const destination = newPath.split("/");
  if (source.length !== destination.length) return oldPath;
  const firstDifference = source.findIndex((name, index) => name !== destination[index]);
  if (firstDifference < 0) return oldPath;
  let firstMovable = source.length - 1;
  while (firstMovable > firstDifference && vault.isOnlyChild &&
      await vault.isOnlyChild(source.slice(0, firstMovable + 1).join("/"))) {
    firstMovable--;
  }
  for (let index = firstMovable; index < source.length; index++) {
    const name = destination[index];
    // A normalization-insensitive filesystem can expose equivalent Unicode
    // spellings that the host's rename API nevertheless rejects as occupied.
    if (source[index] === name || source[index].toLowerCase() !== name.toLowerCase()) continue;
    const from = source.slice(0, index + 1).join("/");
    source[index] = name;
    const to = source.slice(0, index + 1).join("/");
    assertWritableVaultPath(vault, from);
    assertWritableVaultPath(vault, to);
    await vault.rename(from, to);
  }
  return source.join("/");
}

export async function removeVaultPathIfExists(
  writer: Pick<SyncVaultWriter, "exists" | "remove" | "isProtectedVaultPath">,
  path: string | null | undefined,
): Promise<boolean> {
  if (path) {
    assertWritableVaultPath(writer, path);
  }
  if (!path || !(await writer.exists(path))) {
    return false;
  }

  await writer.remove(path);
  return true;
}

function assertWritableVaultPath(
  writer: Pick<SyncVaultWriter, "isProtectedVaultPath">,
  path: string,
): void {
  if (isNeverSyncReservedPath(path) || writer.isProtectedVaultPath?.(path)) {
    throw new Error(`Refusing to modify reserved vault path: ${path}`);
  }
}

export async function ensureParentDirectories(
  writer: Pick<SyncVaultWriter, "exists" | "mkdir">,
  path: string,
): Promise<void> {
  const parts = path.split("/").slice(0, -1);
  let current = "";
  for (const part of parts) {
    if (!part) {
      continue;
    }

    current = current ? `${current}/${part}` : part;
    if (!(await writer.exists(current))) {
      await writer.mkdir(current);
    }
  }
}

function isMarkdownPath(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}
