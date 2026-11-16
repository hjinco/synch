export type AutoSyncTimerType = "push" | "reconnect" | "syncRetry";
type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

export class AutoSyncTimers {
  private readonly timers: Record<AutoSyncTimerType, TimerHandle | null> = {
    push: null,
    reconnect: null,
    syncRetry: null,
  };

  has(type: AutoSyncTimerType): boolean {
    return this.timers[type] !== null;
  }

  set(type: AutoSyncTimerType, callback: () => void, delayMs: number): void {
    this.clear(type);
    this.timers[type] = globalThis.setTimeout(() => {
      this.timers[type] = null;
      callback();
    }, delayMs);
  }

  clear(type: AutoSyncTimerType): void {
    const timer = this.timers[type];
    if (timer === null) {
      return;
    }

    globalThis.clearTimeout(timer);
    this.timers[type] = null;
  }

  clearAll(): void {
    this.clear("push");
    this.clear("reconnect");
    this.clear("syncRetry");
  }
}
