export type SyncLoopState =
  | "stopped"
  | "connecting"
  | "live"
  | "draining"
  | "retry_wait"
  | "reconnect_wait";

export type SyncConnectionState = "connecting" | "live" | "reconnecting";

export class SyncAutoLoopState {
  private state: SyncLoopState = "stopped";
  private runGeneration = 0;

  constructor(
    private readonly onConnectionStateChange?: (state: SyncConnectionState) => void,
  ) {}

  isActive(): boolean {
    return this.state !== "stopped";
  }

  get generation(): number {
    return this.runGeneration;
  }

  isCurrent(generation: number): boolean {
    return this.isActive() && generation === this.runGeneration;
  }

  start(): void {
    if (!this.isActive()) {
      this.runGeneration += 1;
      this.state = "live";
    }
  }

  stop(): void {
    this.state = "stopped";
  }

  set(state: Exclude<SyncLoopState, "stopped">): void {
    // Only an explicit start may activate the loop. Late completions cannot.
    if (!this.isActive() || this.state === state) {
      return;
    }

    const previous = this.state;
    this.state = state;
    if (state === "connecting") {
      this.onConnectionStateChange?.("connecting");
      return;
    }
    if (state === "reconnect_wait") {
      this.onConnectionStateChange?.("reconnecting");
      return;
    }
    if (
      state === "live" &&
      (previous === "connecting" || previous === "reconnect_wait")
    ) {
      this.onConnectionStateChange?.("live");
    }
  }
}
