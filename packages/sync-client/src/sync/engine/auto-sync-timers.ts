export type AutoSyncTimerType = "push" | "reconnect" | "syncRetry";
type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

export class AutoSyncTimers {
  private pushTimer: TimerHandle | null = null;
  private reconnectTimer: TimerHandle | null = null;
  private syncRetryTimer: TimerHandle | null = null;

  has(type: AutoSyncTimerType): boolean {
    return this.get(type) !== null;
  }

  set(type: AutoSyncTimerType, callback: () => void, delayMs: number): void {
    this.clear(type);
    const timer = globalThis.setTimeout(() => {
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

    globalThis.clearTimeout(timer);
    this.assign(type, null);
  }

  clearAll(): void {
    this.clear("push");
    this.clear("reconnect");
    this.clear("syncRetry");
  }

  private get(type: AutoSyncTimerType): TimerHandle | null {
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
    timer: TimerHandle | null,
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
