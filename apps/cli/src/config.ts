export const CLI_VERSION = "0.1.0";
export const CLI_CLIENT_ID = "synch-cli";
export const DEFAULT_CONFIG_DIR_NAME = ".obsidian";

const FALLBACK_API_BASE_URL = "http://127.0.0.1:8787";

export function resolveApiBaseUrl(flagValue?: string): string {
  const candidates = [flagValue, process.env.SYNCH_API_URL];
  for (const candidate of candidates) {
    const normalized = normalizeApiBaseUrl(candidate);
    if (normalized) {
      return normalized;
    }
    if (candidate?.trim()) {
      throw new Error(
        `Invalid API base URL: ${candidate}. Use a http:// or https:// URL.`,
      );
    }
  }

  return FALLBACK_API_BASE_URL;
}

function normalizeApiBaseUrl(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (parsed.search || parsed.hash) {
      return null;
    }
  } catch {
    return null;
  }

  return trimmed;
}
