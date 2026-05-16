import { isNeverSyncReservedPath } from "../core/reserved-paths";

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
    await writer.writeText(path, new TextDecoder().decode(bytes));
    return;
  }

  await writer.writeBinary(path, bytes);
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

export async function writeVaultText(
  writer: Pick<
    SyncVaultWriter,
    "exists" | "mkdir" | "writeText" | "isProtectedVaultPath"
  >,
  path: string,
  content: string,
): Promise<void> {
  assertWritableVaultPath(writer, path);
  await ensureParentDirectories(writer, path);
  await writer.writeText(path, content);
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
