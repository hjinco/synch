export interface SyncEventGateLike {
  isSuppressed(path: string): boolean;
  suppressPaths<T>(
    paths: ReadonlyArray<string | null | undefined>,
    action: () => Promise<T>,
  ): Promise<T>;
}

export class SyncEventGate implements SyncEventGateLike {
  private readonly counts = new Map<string, number>();

  isSuppressed(path: string): boolean {
    return this.counts.has(path);
  }

  async suppressPaths<T>(
    paths: ReadonlyArray<string | null | undefined>,
    action: () => Promise<T>,
  ): Promise<T> {
    const uniquePaths = [...new Set(paths.filter(isNonEmptyPath))];
    for (const path of uniquePaths) {
      this.counts.set(path, (this.counts.get(path) ?? 0) + 1);
    }

    try {
      return await action();
    } finally {
      for (const path of uniquePaths) {
        const next = (this.counts.get(path) ?? 1) - 1;
        if (next <= 0) {
          this.counts.delete(path);
        } else {
          this.counts.set(path, next);
        }
      }
    }
  }
}

function isNonEmptyPath(path: string | null | undefined): path is string {
  return typeof path === "string" && path.trim().length > 0;
}
