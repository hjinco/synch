declare const __SYNCH_API_BASE_URL__: string;

const FALLBACK_API_BASE_URL = "http://127.0.0.1:8787";
const API_BASE_URL = normalizeApiBaseUrl(
  typeof __SYNCH_API_BASE_URL__ === "string"
    ? __SYNCH_API_BASE_URL__
    : FALLBACK_API_BASE_URL,
  FALLBACK_API_BASE_URL,
);

export function getDefaultApiBaseUrl(): string {
  return API_BASE_URL;
}

export type SynchServerDeployment = "official_cloud" | "self_hosted";

export function getServerDeployment(apiBaseUrl: string): SynchServerDeployment {
  try {
    const hostname = new URL(apiBaseUrl).hostname.toLowerCase();
    return hostname === "api.synch.run" || hostname.endsWith(".api.synch.run")
      ? "official_cloud"
      : "self_hosted";
  } catch {
    return "self_hosted";
  }
}

export function normalizeApiBaseUrl(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return fallback;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return fallback;
    }
    if (parsed.search || parsed.hash) {
      return fallback;
    }
  } catch {
    return fallback;
  }

  return trimmed;
}

export function parseApiBaseUrlInput(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }

  const hasProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed);
  const hasSchemeWithoutSlashes =
    /^[a-z][a-z\d+.-]*:/i.test(trimmed) &&
    !/^[^/?#]+:\d+(?:[/?#]|$)/.test(trimmed);
  if (hasSchemeWithoutSlashes && !hasProtocol) {
    throw new Error("API base URL must be a valid http:// or https:// URL.");
  }

  const valueWithProtocol = hasProtocol
    ? trimmed
    : `https://${trimmed}`;
  const normalized = normalizeApiBaseUrl(valueWithProtocol, "");
  if (!normalized) {
    throw new Error("API base URL must be a valid http:// or https:// URL.");
  }

  return normalized;
}
