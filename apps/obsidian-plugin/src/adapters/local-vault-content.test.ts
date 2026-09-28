import type { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { hasExistingVaultFiles } from "./local-vault-content";

function app(files: string[], entries: Record<string, { files: string[]; folders: string[] }>) {
  const list = vi.fn(async (path: string) => {
    const entry = entries[path];
    if (!entry) throw new Error("unreadable folder");
    return entry;
  });
  return {
    app: { vault: { configDir: ".custom-obsidian", getFiles: () => files.map((path) => ({ path })), adapter: { list } } } as unknown as App,
    list,
  };
}

describe("empty local vault check", () => {
  it("counts files regardless of sync filters", async () => {
    const fixture = app(["excluded/image.png"], {});
    expect(await hasExistingVaultFiles(fixture.app)).toBe(true);
    expect(fixture.list).not.toHaveBeenCalled();
  });
  it("allows only Obsidian configuration, trash, and empty folders", async () => {
    const fixture = app([], {
      "": { files: [], folders: [".custom-obsidian", ".trash", "empty"] },
      empty: { files: [], folders: [] },
    });
    expect(await hasExistingVaultFiles(fixture.app)).toBe(false);
    expect(fixture.list).not.toHaveBeenCalledWith(".custom-obsidian");
    expect(fixture.list).not.toHaveBeenCalledWith(".trash");
  });
  it("counts hidden files not indexed by Obsidian", async () => {
    const fixture = app([], {
      "": { files: [], folders: [".hidden"] },
      ".hidden": { files: [".hidden/note.md"], folders: [] },
    });
    expect(await hasExistingVaultFiles(fixture.app)).toBe(true);
  });
  it("fails closed when the adapter cannot read a folder", async () => {
    await expect(hasExistingVaultFiles(app([], {}).app)).rejects.toThrow("unreadable folder");
  });
});
