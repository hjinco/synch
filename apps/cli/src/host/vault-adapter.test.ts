import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_SYNC_FILE_RULES,
  type SyncFileRules,
} from "@synch/sync-client/sync/core/file-rules";
import { NodeSyncVaultAdapter } from "./vault-adapter";

let vaultPath: string;
let rules: SyncFileRules;
let adapter: NodeSyncVaultAdapter;

beforeEach(() => {
  vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "synch-vault-"));
  rules = { ...DEFAULT_SYNC_FILE_RULES, includedHiddenFolders: [] };
  adapter = new NodeSyncVaultAdapter({
    vaultPath,
    getConfigDir: () => ".obsidian",
    getSyncFileRules: () => rules,
  });
});

afterEach(() => {
  fs.rmSync(vaultPath, { recursive: true, force: true });
});

function seed(relativePath: string, content = "content"): void {
  const absolute = path.join(vaultPath, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

describe("NodeSyncVaultAdapter.listFiles", () => {
  it("lists syncable files and skips reserved and hidden paths", async () => {
    seed("notes/a.md");
    seed("image.png");
    seed("script.exe");
    seed(".hidden/inside.md");
    seed(".synch/sync.sqlite");
    seed(".git/HEAD");
    seed(".obsidian/app.json");
    seed(".trash/old.md");

    const files = await adapter.listFiles();
    expect(files.map((file) => file.path).sort()).toEqual([
      "image.png",
      "notes/a.md",
    ]);
    const note = files.find((file) => file.path === "notes/a.md");
    expect(note?.size).toBeGreaterThan(0);
    expect(note?.mtime).toBeGreaterThan(0);
    expect(new TextDecoder().decode(await note?.readBytes())).toBe("content");
  });

  it("includes files under explicitly included hidden folders", async () => {
    seed(".hidden/inside.md");
    seed(".hidden/nested/deep.md");
    seed(".other-hidden/skip.md");
    rules = { ...rules, includedHiddenFolders: [".hidden"] };

    const files = await adapter.listFiles();
    expect(files.map((file) => file.path).sort()).toEqual([
      ".hidden/inside.md",
      ".hidden/nested/deep.md",
    ]);
  });

  it("descends through hidden parents of included hidden folders", async () => {
    seed(".parent/child/inside.md");
    seed(".parent/outside.md");
    rules = { ...rules, includedHiddenFolders: [".parent/child"] };

    const files = await adapter.listFiles();
    expect(files.map((file) => file.path)).toEqual([".parent/child/inside.md"]);
  });
});

describe("NodeSyncVaultAdapter file operations", () => {
  it("writes, reads, renames, and removes files", async () => {
    await adapter.mkdir("folder");
    expect(await adapter.exists("folder")).toBe(true);

    await adapter.writeText("folder/note.md", "hello");
    expect(new TextDecoder().decode(await adapter.readBytes("folder/note.md"))).toBe(
      "hello",
    );

    await adapter.writeBinary("folder/data.bin", new Uint8Array([1, 2, 3]));
    expect([...(await adapter.readBytes("folder/data.bin"))]).toEqual([1, 2, 3]);

    await adapter.rename("folder/note.md", "folder/renamed.md");
    expect(await adapter.exists("folder/note.md")).toBe(false);
    expect(await adapter.exists("folder/renamed.md")).toBe(true);

    await adapter.remove("folder/renamed.md");
    expect(await adapter.exists("folder/renamed.md")).toBe(false);
  });

  it("does not leave temp files behind after writes", async () => {
    await adapter.writeText("note.md", "hello");
    const names = fs.readdirSync(vaultPath);
    expect(names).toEqual(["note.md"]);
  });

  it("rejects unsafe vault paths", async () => {
    await expect(adapter.readBytes("../outside.md")).rejects.toThrow();
    await expect(adapter.writeText("a/../../evil.md", "x")).rejects.toThrow();
    expect(fs.readdirSync(vaultPath)).toEqual([]);
  });

  it("marks reserved and config paths as protected", () => {
    expect(adapter.isProtectedVaultPath(".synch/sync.sqlite")).toBe(true);
    expect(adapter.isProtectedVaultPath(".git/HEAD")).toBe(true);
    expect(adapter.isProtectedVaultPath("notes/a.md")).toBe(false);
  });

  it("reports file stats", async () => {
    seed("stat.md", "12345");
    const stat = await adapter.statFile("stat.md");
    expect(stat?.size).toBe(5);
    expect(await adapter.statFile("missing.md")).toBeNull();
    expect(await adapter.getFileSize("stat.md")).toBe(5);
    await expect(adapter.getFileSize("missing.md")).rejects.toThrow();
  });
});
