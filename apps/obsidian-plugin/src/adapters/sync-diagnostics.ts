import Dexie, { type Table } from "dexie/dist/dexie.mjs";
import type { Plugin } from "obsidian";
import {
  InMemorySyncDiagnostics,
  MAX_SYNC_DIAGNOSTIC_ENTRIES,
  type SyncDiagnosticRecord,
} from "@synch/sync-client/diagnostics";
import { getOrCreateSecretScopeId } from "./secret-scope";

/** Kept on this device, outside the vault's synchronized files. */
export class ObsidianSyncDiagnostics extends InMemorySyncDiagnostics {
  private db?: Dexie;
  private table?: Table<SyncDiagnosticRecord, number>;
  private pending: SyncDiagnosticRecord[] = [];
  private timer?: number;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly plugin: Plugin) {
    super(plugin.manifest.version);
  }

  async initialize(): Promise<void> {
    try {
      const db = new Dexie(`synch:diagnostics:${getOrCreateSecretScopeId(this.plugin)}`);
      db.version(1).stores({ records: "++" });
      this.db = db;
      const table = db.table<SyncDiagnosticRecord, number>("records");
      const previous = await table.reverse().limit(MAX_SYNC_DIAGNOSTIC_ENTRIES).toArray();
      this.records.unshift(...previous.reverse());
      this.table = table;
    } catch {
      // IndexedDB can be unavailable; the current session still has diagnostics.
    }
    this.record({ type: "session_started", pluginVersion: this.plugin.manifest.version });
    await this.flush();
  }

  protected override append(record: SyncDiagnosticRecord): void {
    super.append(record);
    if (!this.table) return;
    this.pending.push(record);
    if (this.pending.length > MAX_SYNC_DIAGNOSTIC_ENTRIES) this.pending.shift();
    this.timer ??= window.setTimeout(() => { void this.flush(); }, 100);
  }

  flush(): Promise<void> {
    window.clearTimeout(this.timer);
    this.timer = undefined;
    const batch = this.pending;
    this.pending = [];
    const db = this.db;
    const table = this.table;
    if (!db || !table || batch.length === 0) return this.writing;

    this.writing = this.writing.then(() => Dexie.ignoreTransaction(() =>
      db.transaction("rw", table, async () => {
        const lastKey = await table.bulkAdd(batch);
        // Auto-generated keys increase monotonically, including across clear().
        await table.where(":id").belowOrEqual(lastKey - MAX_SYNC_DIAGNOSTIC_ENTRIES).delete();
      })
    )).catch(() => {
      // Quota or I/O failures must not interrupt vault operations.
    });
    return this.writing;
  }

  override async clear(): Promise<void> {
    const lastRecord = this.records[this.records.length - 1];
    const table = this.table;
    const cleared = this.flush().then(() => table?.clear());
    this.writing = cleared.catch(() => {});
    await cleared;
    // Keep records appended while deletion was pending, including after a retry.
    const index = lastRecord ? this.records.indexOf(lastRecord) : -1;
    if (index >= 0) {
      this.records.splice(0, index + 1);
      this.notify();
    }
  }

  async close(): Promise<void> {
    await this.flush();
    this.table = undefined;
    this.db?.close();
  }
}
