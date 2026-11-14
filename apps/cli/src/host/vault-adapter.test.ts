import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SYNC_FILE_RULES,
  type SyncFileRules,
} from "@synch/sync-client/core";
import { writeVaultBytes } from "@synch/sync-client/vault";
import { NodeSyncVaultAdapter } from "./vault-adapter";

let vaultPath: string;
let rules: SyncFileRules;
let adapter: NodeSyncVaultAdapter;
let outsidePath: string;

beforeEach(() => {
  vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "synch-vault-"));
  outsidePath = fs.mkdtempSync(path.join(os.tmpdir(), "synch-outside-"));
  rules = { ...DEFAULT_SYNC_FILE_RULES, includedHiddenFolders: [] };
  adapter = new NodeSyncVaultAdapter({
    vaultPath,
    getConfigDir: () => ".obsidian",
    getSyncFileRules: () => rules,
  });
});

afterEach(() => {
  fs.rmSync(vaultPath, { recursive: true, force: true });
  fs.rmSync(outsidePath, { recursive: true, force: true });
});

describe("NodeSyncVaultAdapter symlink boundary", () => {
  beforeEach(() => {
    fs.writeFileSync(path.join(outsidePath, "existing.md"), "outside content");
    fs.symlinkSync(outsidePath, path.join(vaultPath, "linked"), "dir");
    seed("local.md", "local content");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    expect(fs.readdirSync(outsidePath)).toEqual(["existing.md"]);
    expect(fs.readFileSync(path.join(outsidePath, "existing.md"), "utf8")).toBe(
      "outside content",
    );
    expect(fs.readFileSync(path.join(vaultPath, "local.md"), "utf8")).toBe(
      "local content",
    );
  });

  it.each([
    ["text download", () => adapter.writeText("linked/incoming.md", "remote")],
    [
      "binary download",
      () => adapter.writeBinary("linked/incoming.md", new Uint8Array([1])),
    ],
    ["overwrite", () => adapter.writeText("linked/existing.md", "remote")],
    ["mkdir", () => adapter.mkdir("linked/new/nested")],
    [
      "rename destination",
      () => adapter.rename("local.md", "linked/incoming.md"),
    ],
    ["rename source", () => adapter.rename("linked/existing.md", "moved.md")],
    ["remove", () => adapter.remove("linked/existing.md")],
    ["read", () => adapter.readBytes("linked/existing.md")],
    ["size", () => adapter.getFileSize("linked/existing.md")],
    ["stat", () => adapter.statFile("linked/existing.md")],
    ["exists", () => adapter.exists("linked/existing.md")],
    ["missing child", () => adapter.exists("linked/missing.md")],
  ])("rejects %s through a directory symlink", async (_name, operation) => {
    await expect(operation()).rejects.toThrow(/Unsafe vault path.*symlink/);
  });

  it("rejects the download writer before it creates parent directories", async () => {
    await expect(
      writeVaultBytes(
        adapter,
        "linked/new/incoming.md",
        new TextEncoder().encode("remote"),
      ),
    ).rejects.toThrow(/Unsafe vault path.*symlink/);
  });

  it("continues to skip symlinks during enumeration", async () => {
    expect((await adapter.listFiles()).map((file) => file.path)).toEqual([
      "local.md",
    ]);
  });

  it("rejects a symlink installed after enumeration", async () => {
    seed("notes/note.md");
    const files = await adapter.listFiles();
    const note = files.find((file) => file.path === "notes/note.md")!;
    fs.rmSync(path.join(vaultPath, "notes"), { recursive: true });
    fs.symlinkSync(outsidePath, path.join(vaultPath, "notes"), "dir");
    await expect(note.readBytes()).rejects.toThrow(
      /Unsafe vault path.*symlink/,
    );
  });

  it.each([false, true])(
    "rejects file symlinks, including dangling ones (%s)",
    async (dangling) => {
      const target = path.join(
        outsidePath,
        dangling ? "missing.md" : "existing.md",
      );
      fs.symlinkSync(target, path.join(vaultPath, "file.md"), "file");
      await expect(adapter.writeText("file.md", "remote")).rejects.toThrow(
        /symlink/,
      );
      await expect(adapter.readBytes("file.md")).rejects.toThrow(/symlink/);
      await expect(adapter.remove("file.md")).rejects.toThrow(/symlink/);
      expect(
        fs.lstatSync(path.join(vaultPath, "file.md")).isSymbolicLink(),
      ).toBe(true);
    },
  );

  it("rejects dangling directory links and links within the vault", async () => {
    fs.symlinkSync(
      path.join(outsidePath, "missing"),
      path.join(vaultPath, "dangling"),
      "dir",
    );
    fs.mkdirSync(path.join(vaultPath, "real"));
    fs.symlinkSync(
      path.join(vaultPath, "real"),
      path.join(vaultPath, "alias"),
      "dir",
    );
    await expect(adapter.mkdir("dangling/nested")).rejects.toThrow(/symlink/);
    await expect(adapter.writeText("alias/note.md", "remote")).rejects.toThrow(
      /symlink/,
    );
    expect(fs.readdirSync(path.join(vaultPath, "real"))).toEqual([]);
  });

  it("allows selecting the vault itself through a symlink", async () => {
    const alias = path.join(vaultPath, "root-alias");
    fs.symlinkSync(vaultPath, alias, "dir");
    const throughAlias = new NodeSyncVaultAdapter({
      vaultPath: alias,
      getConfigDir: () => ".obsidian",
      getSyncFileRules: () => rules,
    });
    await throughAlias.mkdir("new/nested");
    await throughAlias.writeText("new/nested/note.md", "hello");
    expect(await throughAlias.getFileSize("new/nested/note.md")).toBe(5);
  });

  it("does not follow or remove a pre-existing temp-file symlink", async () => {
    const open = fsPromises.open.bind(fsPromises);
    let tempPath = "";
    vi.spyOn(fsPromises, "open").mockImplementationOnce(
      async (file, flags, mode) => {
        tempPath = String(file);
        fs.symlinkSync(path.join(outsidePath, "existing.md"), tempPath, "file");
        return open(file, flags, mode);
      },
    );
    await expect(
      adapter.writeText("incoming.md", "remote"),
    ).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(fs.lstatSync(tempPath).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(vaultPath, "incoming.md"))).toBe(false);
  });
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
    expect(
      new TextDecoder().decode(await adapter.readBytes("folder/note.md")),
    ).toBe("hello");

    await adapter.writeBinary("folder/data.bin", new Uint8Array([1, 2, 3]));
    expect([...(await adapter.readBytes("folder/data.bin"))]).toEqual([
      1, 2, 3,
    ]);

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

  it("cleans up its temp file when the final rename fails", async () => {
    await adapter.mkdir("folder");
    await expect(adapter.writeText("folder", "hello")).rejects.toThrow();
    expect(fs.readdirSync(vaultPath)).toEqual(["folder"]);
  });

  it("rejects unsafe vault paths", async () => {
    await expect(adapter.readBytes("../outside.md")).rejects.toThrow();
    await expect(adapter.writeText("a/../../evil.md", "x")).rejects.toThrow();
    expect(fs.readdirSync(vaultPath)).toEqual([]);
  });

  it.each([
    "../outside.md",
    "a/../outside.md",
    "/outside.md",
    "a\\..\\outside.md",
    "C:outside.md",
    "bad\0.md",
  ])("does not hide unsafe path errors for %s", async (unsafe) => {
    await expect(adapter.exists(unsafe)).rejects.toThrow("Unsafe vault path");
    await expect(adapter.statFile(unsafe)).rejects.toThrow("Unsafe vault path");
    await expect(adapter.mkdir(unsafe)).rejects.toThrow("Unsafe vault path");
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
