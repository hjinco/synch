export type AutoSyncTimerType = "push" | "reconnect" | "syncRetry";

export class AutoSyncTimers {
  private pushTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private syncRetryTimer: number | null = null;

  has(type: AutoSyncTimerType): boolean {
    return this.get(type) !== null;
  }

  set(type: AutoSyncTimerType, callback: () => void, delayMs: number): void {
    this.clear(type);
    const timer = window.setTimeout(() => {
      this.assign(type, null);
      callback();
    }, delayMs);
    this.assign(type, timer);
  }

  clear(type: AutoSyncTimerType): void {
    const timer = this.get(type);
    if (!timer) {
      return;
    }

    window.clearTimeout(timer);
    this.assign(type, null);
  }

  clearAll(): void {
    this.clear("push");
    this.clear("reconnect");
    this.clear("syncRetry");
  }

  private get(type: AutoSyncTimerType): number | null {
    if (type === "push") {
      return this.pushTimer;
    }
    if (type === "reconnect") {
      return this.reconnectTimer;
    }
    return this.syncRetryTimer;
  }

  private assign(
    type: AutoSyncTimerType,
    timer: number | null,
  ): void {
    if (type === "push") {
      this.pushTimer = timer;
      return;
    }
    if (type === "reconnect") {
      this.reconnectTimer = timer;
      return;
    }
    this.syncRetryTimer = timer;
  }
}
