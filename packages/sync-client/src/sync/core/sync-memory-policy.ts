/** Source bytes in flight. Oversized individual files are admitted exclusively. */
export function resolveSyncMemoryBudget(input: {
  totalMemoryBytes?: number;
  isMobile: boolean;
}): number {
  const total = input.totalMemoryBytes;
  if (total === undefined || !Number.isFinite(total) || total <= 0) {
    // Only a fallback for hosts which cannot report RAM, never a device cap.
    return (input.isMobile ? 128 : 512) * 1024 * 1024;
  }
  return Math.max(1, Math.floor(total * (input.isMobile ? 0.1 : 0.2)));
}
