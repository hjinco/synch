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

  constructor(
    private readonly onConnectionStateChange?: (state: SyncConnectionState) => void,
  ) {}

  isActive(): boolean {
    return this.state !== "stopped";
  }

  set(state: SyncLoopState): void {
    if (this.state === state) {
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
