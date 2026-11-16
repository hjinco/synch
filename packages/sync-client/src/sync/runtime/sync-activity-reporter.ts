import type {
  SyncOperationProgress,
  UserVisibleSyncProgress,
  VaultSyncProgress,
} from "./user-visible-status";

export type SyncActivityKind = "push" | "pull" | "local";
type ProgressReporter = (progress: SyncOperationProgress) => Promise<void>;

interface SyncActivity {
  kind: SyncActivityKind;
  progress?: SyncOperationProgress;
}

interface SyncActivityReporterDeps {
  setProgress: (progress: UserVisibleSyncProgress) => void;
  getBaselineProgress: () => Promise<VaultSyncProgress>;
}

/** Owns both activity lifetimes and their reports, including overlapping work. */
export class SyncActivityReporter {
  private readonly activities = new Set<SyncActivity>();

  constructor(private readonly deps: SyncActivityReporterDeps) {}

  async run<T>(
    kind: SyncActivityKind,
    work: (report: ProgressReporter) => Promise<T>,
  ): Promise<T> {
    const activity: SyncActivity = { kind };
    this.activities.add(activity);
    try {
      return await work(async (progress) => {
        if (!this.activities.has(activity)) return;
        activity.progress = progress;
        if (this.visibleRemoteActivity() === activity) {
          this.deps.setProgress(progress);
        }
      });
    } finally {
      const wasVisible = this.visibleRemoteActivity() === activity;
      this.activities.delete(activity);
      const visible = this.visibleRemoteActivity();
      if (wasVisible && visible?.progress) {
        this.deps.setProgress(visible.progress);
      }
      await this.refreshBaseline();
    }
  }

  async refreshBaseline(): Promise<void> {
    const progress = await this.deps.getBaselineProgress();
    // Check after the asynchronous read: another operation may have started.
    if (this.activities.size === 0) {
      this.deps.setProgress(progress);
    }
  }

  private visibleRemoteActivity(): SyncActivity | undefined {
    for (const activity of this.activities) {
      if (activity.kind !== "local") return activity;
    }
    return undefined;
  }
}
