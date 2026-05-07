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

export interface SyncFileRules {
  includeImages: boolean;
  includeAudio: boolean;
  includeVideos: boolean;
  includePdf: boolean;
  includeOtherFiles: boolean;
  excludedFolders: string[];
}

export const DEFAULT_SYNC_FILE_RULES: SyncFileRules = {
  includeImages: true,
  includeAudio: true,
  includeVideos: true,
  includePdf: true,
  includeOtherFiles: false,
  excludedFolders: [],
};

export function normalizeSyncFileRules(value: unknown): SyncFileRules {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ...DEFAULT_SYNC_FILE_RULES,
      excludedFolders: [...DEFAULT_SYNC_FILE_RULES.excludedFolders],
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
  };
}

export function shouldSyncPath(path: string, rules: SyncFileRules): boolean {
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

  if (hasHiddenSegment(normalizedPath)) {
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
    if (!normalized || hasHiddenSegment(normalized)) {
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

function isExcludedByFolder(path: string, excludedFolders: ReadonlyArray<string>): boolean {
  return excludedFolders.some(
    (folder) => path === folder || path.startsWith(`${folder}/`),
  );
}

function hasHiddenSegment(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith("."));
}

function isSyncConflictFile(path: string): boolean {
  const parts = path.split("/");
  const basename = parts[parts.length - 1] ?? "";
  return SYNC_CONFLICT_FILE_PATTERN.test(basename);
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
