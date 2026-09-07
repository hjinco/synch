import { Platform } from "obsidian";
import { resolveSyncMemoryBudget } from "@synch/sync-client/core";

export function getSyncMemoryBudget(): number {
  let totalMemoryBytes: number | undefined;
  if (Platform.isDesktop && typeof window !== "undefined") {
    try {
      const host = window as Window & {
        process?: { getSystemMemoryInfo?: () => { total: number } };
      };
      // Electron reports KiB. Do not import Node/Electron into mobile bundles.
      const totalKiB = host.process?.getSystemMemoryInfo?.().total;
      if (totalKiB && Number.isFinite(totalKiB) && totalKiB > 0) {
        totalMemoryBytes = totalKiB * 1024;
      }
    } catch { /* Fall back to the browser signal when the host API is unavailable. */ }
  }
  if (totalMemoryBytes === undefined && typeof navigator !== "undefined") {
    const memoryGiB = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    if (memoryGiB && Number.isFinite(memoryGiB) && memoryGiB > 0) {
      totalMemoryBytes = memoryGiB * 1024 ** 3;
    }
  }
  return resolveSyncMemoryBudget({ totalMemoryBytes, isMobile: Platform.isMobile });
}
