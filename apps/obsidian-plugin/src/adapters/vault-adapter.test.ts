import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SYNC_FILE_RULES } from "@synch/sync-client/core";
import { createTestPlugin } from "../test-support/test-plugin";
import { ObsidianSyncVaultAdapter } from "./vault-adapter";

describe("ObsidianSyncVaultAdapter", () => {
  it("compares the current note inside the host update and preserves newer content", async () => {
    const plugin = createTestPlugin();
    const adapter = new ObsidianSyncVaultAdapter(plugin, () => DEFAULT_SYNC_FILE_RULES);
    const note = "\uFEFFnewer content";
    await adapter.writeText("note.md", note);
    expect(await adapter.writeTextIfUnchanged("note.md", "older content", "merge")).toBe(false);
    expect(await plugin.app.vault.adapter.read("note.md")).toBe(note);
    expect(await adapter.writeTextIfUnchanged("note.md", note, "\uFEFFmerge")).toBe(true);
    expect(await plugin.app.vault.adapter.read("note.md")).toBe("\uFEFFmerge");
    expect(await adapter.writeTextIfUnchanged("missing.md", note, "merge")).toBe(false);
    await adapter.mkdir("folder");
    expect(await adapter.writeTextIfUnchanged("folder", note, "merge")).toBe(false);
  });

  it("preserves malformed UTF-8 even when a lossy read would match the source text", async () => {
    const plugin = createTestPlugin();
    const adapter = new ObsidianSyncVaultAdapter(plugin, () => DEFAULT_SYNC_FILE_RULES);
    const malformed = Uint8Array.of(97, 255, 98);
    const process = vi.spyOn(plugin.app.vault.adapter, "process");
    await adapter.writeBinary("note.md", malformed);
    expect(await adapter.writeTextIfUnchanged("note.md", "a\uFFFDb", "merged")).toBe(false);
    expect(await adapter.readBytes("note.md")).toEqual(malformed);
    await adapter.writeText("note.md", "a\uFFFDb");
    expect(await adapter.writeTextIfUnchanged("note.md", "a\uFFFDb", "merged")).toBe(false);
    expect(adapter.canCompareTextForWrite(malformed)).toBe(false);
    expect(adapter.canCompareTextForWrite(new TextEncoder().encode("a\uFFFDb"))).toBe(false);
    expect(process).not.toHaveBeenCalled();
  });

  it("distinguishes aliases of parent folders from separate files on a case-sensitive vault", async () => {
    const plugin = createTestPlugin();
    const adapter = new ObsidianSyncVaultAdapter(plugin, () => DEFAULT_SYNC_FILE_RULES);
    await adapter.writeText("Notes/a.md", "first");
    await adapter.writeText("notes/a.md", "second");
    await adapter.mkdir("Notes");
    await adapter.mkdir("notes");
    expect(await adapter.areSameFilePaths("Notes/a.md", "notes/a.md")).toBe(false);

    vi.spyOn(plugin.app.vault.adapter, "exists").mockImplementation(async (path, sensitive) =>
      !sensitive || path !== "notes");
    expect(await adapter.areSameFilePaths("Notes/a.md", "notes/a.md")).toBe(true);
  });

  it("counts hidden siblings before renaming a parent folder", async () => {
    const plugin = createTestPlugin();
    const adapter = new ObsidianSyncVaultAdapter(plugin, () => DEFAULT_SYNC_FILE_RULES);
    await adapter.writeText("Notes/a.md", "note");
    expect(await adapter.isOnlyChild("Notes/a.md")).toBe(true);
    await adapter.writeText("Notes/.hidden", "local only");
    expect(await adapter.isOnlyChild("Notes/a.md")).toBe(false);
  });

  it("preserves a file created while an interrupted download is being installed", async () => {
    const plugin = createTestPlugin();
    const adapter = new ObsidianSyncVaultAdapter(plugin, () => DEFAULT_SYNC_FILE_RULES);
    const copy = plugin.app.vault.adapter.copy.bind(plugin.app.vault.adapter);
    vi.spyOn(plugin.app.vault.adapter, "copy").mockImplementationOnce(async (source, path) => {
      await adapter.writeText(path, "new edit");
      await copy(source, path);
    });
    const payload = Uint8Array.of(1, 2);
    expect(await adapter.writeBytesIfAbsent("note.md", payload, "operation")).toBe(false);
    expect(await plugin.app.vault.adapter.read("note.md")).toBe("new edit");
    expect(await adapter.writeBytesIfAbsent("download.bin", payload, "operation")).toBe(true);
    expect(await adapter.readBytes("download.bin")).toEqual(payload);
    expect((await plugin.app.vault.adapter.list(plugin.manifest.dir!)).files).toEqual([]);
  });

  it("treats a note below a replaced parent as missing and propagates I/O errors", async () => {
    const plugin = createTestPlugin();
    const adapter = new ObsidianSyncVaultAdapter(plugin, () => DEFAULT_SYNC_FILE_RULES);
    const stat = vi.spyOn(plugin.app.vault.adapter, "stat");
    stat.mockRejectedValueOnce(Object.assign(new Error("not a directory"), { code: "ENOTDIR" }));
    expect(await adapter.statKind("replaced/note.md")).toBe(null);
    const failure = Object.assign(new Error("unavailable"), { code: "EIO" });
    stat.mockRejectedValueOnce(failure);
    await expect(adapter.statKind("note.md")).rejects.toBe(failure);
  });

  it.each([
    Object.assign(new Error("No space left on device"), { code: "ENOSPC" }),
    new Error("Native copy failed"),
  ])("propagates a copy error after it writes a partial destination (%s)", async (failure) => {
    const plugin = createTestPlugin();
    const adapter = new ObsidianSyncVaultAdapter(plugin, () => DEFAULT_SYNC_FILE_RULES);
    const partial = Uint8Array.of(1);
    vi.spyOn(plugin.app.vault.adapter, "copy").mockImplementationOnce(async (_source, path) => {
      await adapter.writeBinary(path, partial);
      throw failure;
    });
    await expect(adapter.writeBytesIfAbsent("download.bin", Uint8Array.of(1, 2), "operation")).rejects.toBe(failure);
    expect(await adapter.readBytes("download.bin")).toEqual(partial);
    expect((await plugin.app.vault.adapter.list(plugin.manifest.dir!)).files).toEqual([]);
  });

  it("lists files from included hidden folders through the adapter", async () => {
    const plugin = createTestPlugin();
    await plugin.app.vault.adapter.mkdir(".assets");
    await plugin.app.vault.adapter.mkdir(".assets/nested");
    await plugin.app.vault.adapter.writeBinary(
      ".assets/nested/file.md",
      new TextEncoder().encode("hidden").buffer,
    );
    await plugin.app.vault.adapter.mkdir(".git");
    await plugin.app.vault.adapter.writeBinary(
      ".git/config",
      new TextEncoder().encode("ignored").buffer,
    );
    const adapter = new ObsidianSyncVaultAdapter(plugin, () => ({
      ...DEFAULT_SYNC_FILE_RULES,
      includedHiddenFolders: [".assets", ".git"],
    }));

    const files = await adapter.listFiles();

    expect(files.map((file) => file.path)).toEqual([".assets/nested/file.md"]);
    await expect(files[0]?.readBytes()).resolves.toEqual(
      new TextEncoder().encode("hidden"),
    );
  });
});
