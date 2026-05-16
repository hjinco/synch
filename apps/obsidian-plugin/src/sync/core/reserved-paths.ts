const NEVER_SYNC_RESERVED_SEGMENTS = new Set([
  ".git",
  ".trash",
  ".synch",
  "node_modules",
]);

export type SyncPathSafetyClass =
  | "normal"
  | "reserved-never-sync"
  | "reserved-config-managed";

export function classifySyncPath(
  path: string,
  configDir = ".obsidian",
): SyncPathSafetyClass {
  const normalized = normalizeReservedPath(path);
  if (!normalized) {
    return "normal";
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => NEVER_SYNC_RESERVED_SEGMENTS.has(segment))) {
    return "reserved-never-sync";
  }

  if (segments[0] === configDir) {
    return "reserved-config-managed";
  }

  return "normal";
}

export function isReservedSyncPath(path: string): boolean {
  return classifySyncPath(path) !== "normal";
}

export function isNeverSyncReservedPath(path: string): boolean {
  return classifySyncPath(path) === "reserved-never-sync";
}

function normalizeReservedPath(path: string): string {
  return path.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}
