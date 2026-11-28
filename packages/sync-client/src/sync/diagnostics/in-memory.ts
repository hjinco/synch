import {
  formatDiagnosticError,
  formatDiagnosticEvent,
  formatDiagnosticText,
  type SyncDiagnosticRecord,
} from "./format";
import type {
  SyncDiagnosticError,
  SyncDiagnosticEvent,
  SyncDiagnostics,
  SyncDiagnosticsSnapshot,
} from "./types";

export const MAX_SYNC_DIAGNOSTIC_ENTRIES = 1_000;

export interface InMemorySyncDiagnosticsOptions {
  now?: () => Date;
}

export class InMemorySyncDiagnostics implements SyncDiagnostics {
  protected readonly records: SyncDiagnosticRecord[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly now: () => Date;

  constructor(
    private readonly pluginVersion: string,
    options: InMemorySyncDiagnosticsOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  record(event: SyncDiagnosticEvent): void {
    this.append(formatDiagnosticEvent(event, this.now().toISOString()));
  }

  recordError(input: SyncDiagnosticError): void {
    this.append(formatDiagnosticError(input, this.now().toISOString()));
  }

  get count(): number {
    return this.records.length;
  }

  clear(): void | Promise<void> {
    if (this.records.length === 0) {
      return;
    }
    this.records.length = 0;
    this.notify();
  }

  getSnapshot(): SyncDiagnosticsSnapshot {
    return {
      count: this.records.length,
      text: formatDiagnosticText(this.pluginVersion, this.records),
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  protected append(record: SyncDiagnosticRecord): void {
    this.records.push(record);
    if (this.records.length > MAX_SYNC_DIAGNOSTIC_ENTRIES) this.records.shift();
    this.notify();
  }

  protected notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
