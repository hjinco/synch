export type OfflineDetector = () => boolean;

const OFFLINE_ERROR_MARKERS = [
  "offline",
  "failed to fetch",
  "networkerror",
  "network error",
  "network request failed",
  "load failed",
  "internet",
  "enotfound",
  "econnrefused",
  "econnreset",
  "etimedout",
];

export function isBrowserOffline(): boolean {
  return (
    typeof globalThis.navigator !== "undefined" &&
    globalThis.navigator.onLine === false
  );
}

export function isOffline(isOfflineOverride?: OfflineDetector): boolean {
  return isOfflineOverride?.() ?? isBrowserOffline();
}

export function isOfflineLikeError(
  error: unknown,
  isOfflineOverride?: OfflineDetector,
): boolean {
  if (isOffline(isOfflineOverride)) {
    return true;
  }

  const message = getErrorText(error).toLowerCase();
  return OFFLINE_ERROR_MARKERS.some((marker) => message.includes(marker));
}

function getErrorText(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name} ${error.message}`;
  }

  return String(error);
}
