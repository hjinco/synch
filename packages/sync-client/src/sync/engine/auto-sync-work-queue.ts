export interface PendingSyncWork {
  push: boolean;
  pullTargetCursor: number | null;
}

export class PendingSyncWorkQueue {
  private readonly pendingWork: PendingSyncWork = {
    push: false,
    pullTargetCursor: null,
  };

  get push(): boolean {
    return this.pendingWork.push;
  }

  get pullTargetCursor(): number | null {
    return this.pendingWork.pullTargetCursor;
  }

  requestPush(): void {
    this.pendingWork.push = true;
  }

  requestPull(targetCursor: number | null): void {
    if (targetCursor === null) {
      this.pendingWork.pullTargetCursor ??= 0;
      return;
    }

    this.pendingWork.pullTargetCursor = Math.max(
      this.pendingWork.pullTargetCursor ?? 0,
      targetCursor,
    );
  }

  hasPendingWork(): boolean {
    return this.pendingWork.push || this.pendingWork.pullTargetCursor !== null;
  }

  takePendingWork(): PendingSyncWork {
    const work = {
      push: this.pendingWork.push,
      pullTargetCursor: this.pendingWork.pullTargetCursor,
    };
    this.clear();
    return work;
  }

  clear(): void {
    this.pendingWork.push = false;
    this.pendingWork.pullTargetCursor = null;
  }
}
