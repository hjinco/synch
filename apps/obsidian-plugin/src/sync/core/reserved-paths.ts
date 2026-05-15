const RESERVED_SEGMENTS = new Set([
  ".git",
  ".obsidian",
  ".trash",
  ".synch",
  "node_modules",
]);

export function isReservedSyncPath(path: string): boolean {
  const normalized = path.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized) {
    return false;
  }

  return normalized
    .split("/")
    .some((segment) => RESERVED_SEGMENTS.has(segment));
}
