export const SYNCH_DEVICE_LOGIN_RETURN_URI = "obsidian://synch-device-login";

export function openExternalUrl(url: string): void {
  window.open(url, "_external", "noopener,noreferrer");
}
