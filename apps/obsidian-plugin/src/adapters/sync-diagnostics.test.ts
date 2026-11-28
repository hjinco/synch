import { describe, expect, it, vi } from "vitest";
import { createTestPlugin } from "../test-support/test-plugin";
import { ObsidianSyncDiagnostics } from "./sync-diagnostics";

describe("persistent sync diagnostics", () => {
  it("restores committed records before orderly shutdown and clears pending and saved records", async () => {
    const plugin = createTestPlugin();
    plugin.manifest.version = "test";
    const first = new ObsidianSyncDiagnostics(plugin);
    await first.initialize();
    for (let i = 0; i < 1004; i++) {
      first.record({ type: "local_file_queued", operation: "modify", path: `note-${i}.md` });
    }
    await first.flush();
    const second = new ObsidianSyncDiagnostics(plugin);
    await second.initialize();
    expect(second.getSnapshot().count).toBe(1000);
    expect(second.getSnapshot().text).not.toContain('"note-4.md"');
    expect(second.getSnapshot().text).toContain('"note-5.md"');
    expect(second.getSnapshot().text).toContain('"note-1003.md"');
    expect(second.getSnapshot().text.split("\n").at(-1)).toContain("session_started");
    second.record({ type: "sync_completed", source: "manual" });
    await second.clear();
    await Promise.all([first.close(), second.close()]);
    const third = new ObsidianSyncDiagnostics(plugin);
    await third.initialize();
    expect(third.getSnapshot().count).toBe(1);
    await third.close();
  });

  it("keeps logs on delete failure and preserves new entries during retry", async () => {
    const plugin = createTestPlugin();
    plugin.manifest.version = "test";
    const logs = new ObsidianSyncDiagnostics(plugin);
    await logs.initialize();
    const failure = vi.spyOn(IDBObjectStore.prototype, "clear").mockImplementationOnce(() => {
      throw new Error("disk unavailable");
    });
    try {
      await expect(logs.clear()).rejects.toThrow();
      expect(logs.getSnapshot().text).toContain("session_started");
    } finally {
      failure.mockRestore();
    }
    const retry = logs.clear();
    logs.record({ type: "sync_completed", source: "manual" });
    await retry;
    expect(logs.count).toBe(1);
    expect(logs.getSnapshot().text).toContain("sync_completed");
    await logs.close();
    const reopened = new ObsidianSyncDiagnostics(plugin);
    await reopened.initialize();
    expect(reopened.count).toBe(2);
    expect(reopened.getSnapshot().text).toContain("sync_completed");
    await reopened.close();
  });

  it("keeps recording in memory when device storage is unavailable", async () => {
    const plugin = createTestPlugin();
    plugin.manifest.version = "test";
    vi.spyOn(plugin.app, "loadLocalStorage").mockImplementation(() => { throw new Error("Unavailable"); });
    const diagnostics = new ObsidianSyncDiagnostics(plugin);
    await diagnostics.initialize();
    diagnostics.record({ type: "sync_completed", source: "manual" });
    await diagnostics.flush();
    expect(diagnostics.getSnapshot().text).toContain("sync_completed");
    await diagnostics.close();
  });
});
