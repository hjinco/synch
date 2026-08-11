export function toWebSocketUrl(apiBaseUrl: string, vaultId: string): string {
  const normalized = apiBaseUrl.replace(/\/+$/, "");
  if (normalized.startsWith("https://")) {
    return `${normalized.replace(/^https:\/\//, "wss://")}/v1/vaults/${encodeURIComponent(vaultId)}/socket`;
  }

  if (normalized.startsWith("http://")) {
    return `${normalized.replace(/^http:\/\//, "ws://")}/v1/vaults/${encodeURIComponent(vaultId)}/socket`;
  }

  throw new Error("API base URL must use http:// or https:// for sync websocket connections.");
}

