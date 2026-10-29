import { isReservedSyncPath } from "./reserved-paths";

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "avif",
  "heic",
  "bmp",
  "ico",
]);

const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "wav", "flac", "ogg", "aac"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "mkv", "webm", "avi", "m4v"]);
const PDF_EXTENSIONS = new Set(["pdf"]);
const SYNC_CONFLICT_FILE_PATTERN =
  /\.sync-conflict-\d{8}-\d{6}(?:-\d+)?(?:\.[^/.]+)?$/;
/**
 * Same marker, but capturing the stem and extension separately. The pattern
 * above is used for exclusion tests where a boolean is all that matters; this
 * one exists so a caller can recover the original path without re-deriving the
 * marker's shape.
 */
const SYNC_CONFLICT_FILE_PARTS =
  /^(?<stem>.*?)\.sync-conflict-\d{8}-\d{6}(?:-\d+)?(?<extension>\.[^/.]+)?$/;

export interface SyncFileRules {
  includeImages: boolean;
  includeAudio: boolean;
  includeVideos: boolean;
  includePdf: boolean;
  includeOtherFiles: boolean;
  excludedFolders: string[];
  includedHiddenFolders: string[];
}

export const DEFAULT_SYNC_FILE_RULES: SyncFileRules = {
  includeImages: true,
  includeAudio: true,
  includeVideos: true,
  includePdf: true,
  includeOtherFiles: false,
  excludedFolders: [],
  includedHiddenFolders: [],
};

export function normalizeSyncFileRules(
  value: unknown,
  configDir = "",
): SyncFileRules {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ...DEFAULT_SYNC_FILE_RULES,
      excludedFolders: [...DEFAULT_SYNC_FILE_RULES.excludedFolders],
      includedHiddenFolders: [...DEFAULT_SYNC_FILE_RULES.includedHiddenFolders],
    };
  }

  const record = value as Record<string, unknown>;
  return {
    includeImages: asBoolean(record.includeImages, DEFAULT_SYNC_FILE_RULES.includeImages),
    includeAudio: asBoolean(record.includeAudio, DEFAULT_SYNC_FILE_RULES.includeAudio),
    includeVideos: asBoolean(record.includeVideos, DEFAULT_SYNC_FILE_RULES.includeVideos),
    includePdf: asBoolean(record.includePdf, DEFAULT_SYNC_FILE_RULES.includePdf),
    includeOtherFiles: asBoolean(
      record.includeOtherFiles,
      DEFAULT_SYNC_FILE_RULES.includeOtherFiles,
    ),
    excludedFolders: normalizeExcludedFolders(record.excludedFolders),
    includedHiddenFolders: normalizeIncludedHiddenFolders(
      record.includedHiddenFolders,
      configDir,
    ),
  };
}

export function shouldSyncPath(
  path: string,
  rules: SyncFileRules,
  configDir = "",
): boolean {
  const normalizedPath = normalizeVaultPath(path);
  if (!normalizedPath) {
    return false;
  }

  if (isSyncConflictFile(normalizedPath)) {
    return false;
  }

  if (isExcludedByFolder(normalizedPath, rules.excludedFolders)) {
    return false;
  }

  if (isReservedSyncPath(normalizedPath, configDir)) {
    return false;
  }

  if (
    pathHasHiddenSegment(normalizedPath) &&
    !isPathUnderFolders(normalizedPath, rules.includedHiddenFolders)
  ) {
    return false;
  }

  const extension = getExtension(normalizedPath);
  if (extension === "md") {
    return true;
  }

  if (IMAGE_EXTENSIONS.has(extension)) {
    return rules.includeImages;
  }

  if (AUDIO_EXTENSIONS.has(extension)) {
    return rules.includeAudio;
  }

  if (VIDEO_EXTENSIONS.has(extension)) {
    return rules.includeVideos;
  }

  if (PDF_EXTENSIONS.has(extension)) {
    return rules.includePdf;
  }

  return rules.includeOtherFiles;
}

export function normalizeExcludedFolders(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }

    const normalized = normalizeVaultPath(entry);
    if (
      !normalized ||
      pathHasHiddenSegment(normalized) ||
      isReservedSyncPath(normalized)
    ) {
      continue;
    }

    seen.add(normalized);
  }

  const sorted = [...seen].sort((left, right) => left.localeCompare(right));
  return pruneSubpaths(sorted);
}

export function normalizeIncludedHiddenFolders(
  value: unknown,
  configDir = "",
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }

    const normalized = normalizeVaultPath(entry);
    if (
      !normalized ||
      !pathHasHiddenSegment(normalized) ||
      isReservedSyncPath(normalized, configDir)
    ) {
      continue;
    }

    seen.add(normalized);
  }

  const sorted = [...seen].sort((left, right) => left.localeCompare(right));
  return pruneSubpaths(sorted);
}

export function normalizeVaultPath(path: string): string {
  return path.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

export function pathHasHiddenSegment(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith("."));
}

export function isPathUnderFolders(
  path: string,
  folders: ReadonlyArray<string>,
): boolean {
  return folders.some(
    (folder) => path === folder || path.startsWith(`${folder}/`),
  );
}

function pruneSubpaths(sortedPaths: readonly string[]): string[] {
  const result: string[] = [];
  for (const path of sortedPaths) {
    const coveredByExisting = result.some((parent) =>
      path.startsWith(`${parent}/`),
    );
    if (!coveredByExisting) {
      result.push(path);
    }
  }
  return result;
}

function isExcludedByFolder(
  path: string,
  excludedFolders: ReadonlyArray<string>,
): boolean {
  return isPathUnderFolders(path, excludedFolders);
}

/** True for file types the vault can show as an image. */
export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(getExtension(path));
}

function isSyncConflictFile(path: string): boolean {
  const parts = path.split("/");
  const basename = parts[parts.length - 1] ?? "";
  return SYNC_CONFLICT_FILE_PATTERN.test(basename);
}

/**
 * The path a conflict copy was made from, or null when `path` is not one.
 *
 * Conflict copies are written as `<stem>.sync-conflict-<timestamp>[-n]<ext>`
 * next to the original, so the original is recovered by trimming the marker
 * and rejoining the stem with the extension. Callers use this to pair a copy
 * with the file the user actually edited; the original may no longer exist
 * (a path collision can leave the copy as the only surviving version).
 */
export function getConflictOriginalPath(path: string): string | null {
  const slashIndex = path.lastIndexOf("/");
  const parent = slashIndex >= 0 ? path.slice(0, slashIndex) : "";
  const basename = slashIndex >= 0 ? path.slice(slashIndex + 1) : path;
  const match = SYNC_CONFLICT_FILE_PARTS.exec(basename);
  const stem = match?.groups?.stem;
  if (stem === undefined) {
    return null;
  }

  const extension = match?.groups?.extension ?? "";
  return `${parent ? `${parent}/` : ""}${stem}${extension}`;
}

function getExtension(path: string): string {
  const parts = path.split("/");
  const basename = parts[parts.length - 1] ?? "";
  const dotIndex = basename.lastIndexOf(".");
  if (dotIndex < 0) {
    return "";
  }

  return basename.slice(dotIndex + 1).toLowerCase();
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}
