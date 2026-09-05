import type { SyncOperationProgress } from "../runtime/user-visible-status";

/** Counts only members of one invocation, independently of mutable remote totals. */
export class SyncWorkProgress {
  private readonly registered = new Set<string>();
  private readonly completed = new Set<string>();
  private sealed = false;

  constructor(private readonly direction: "pull" | "push") {}

  register(ids: Iterable<string>): void {
    if (this.sealed) {
      throw new Error("Sync work is already sealed.");
    }
    for (const id of ids) this.registered.add(id);
  }

  complete(ids: Iterable<string>): void {
    for (const id of ids) {
      if (!this.registered.has(id)) {
        throw new Error("Unregistered sync work.");
      }
      this.completed.add(id);
    }
  }

  seal(): void {
    this.sealed = true;
  }

  snapshot(): SyncOperationProgress {
    return {
      direction: this.direction,
      totalKnown: this.sealed,
      completedEntries: this.completed.size,
      totalEntries: this.registered.size,
    };
  }
}
