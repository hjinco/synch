export type SyncActivityKind = "push" | "pull" | "local";

export interface ActiveSyncActivity {
  id: number;
  kind: SyncActivityKind;
}

export class SyncActivityTracker {
  private activities: ActiveSyncActivity[] = [];
  private nextActivityId = 1;

  begin(kind: SyncActivityKind): ActiveSyncActivity {
    const activity = {
      id: this.nextActivityId,
      kind,
    };
    this.nextActivityId += 1;
    this.activities.push(activity);
    return activity;
  }

  end(activity: ActiveSyncActivity): void {
    this.activities = this.activities.filter(
      (activeActivity) => activeActivity.id !== activity.id,
    );
  }

  contains(activity: ActiveSyncActivity): boolean {
    return this.activities.some((active) => active.id === activity.id);
  }

  visibleRemoteActivity(): ActiveSyncActivity | undefined {
    return this.activities.find((activity) => activity.kind !== "local");
  }

  hasActiveRemoteActivity(): boolean {
    return this.activities.some((activity) => activity.kind !== "local");
  }

  hasActiveActivities(): boolean {
    return this.activities.length > 0;
  }
}
