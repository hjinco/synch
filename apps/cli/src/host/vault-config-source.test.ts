import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import { DEFAULT_VAULT_CONFIG_SYNC_RULES } from "@synch/sync-client/core";
import { NodeVaultConfigSource } from "./vault-config-source";

let temporary: string;
let vaultPath: string;
let outsidePath: string;
let source: NodeVaultConfigSource;

beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), "synch-config-"));
  vaultPath = path.join(temporary, "vault");
  outsidePath = path.join(temporary, "outside");
  fs.mkdirSync(vaultPath);
  fs.mkdirSync(outsidePath);
  fs.writeFileSync(path.join(outsidePath, "app.json"), "outside content");
  source = new NodeVaultConfigSource({
    vaultPath,
    getConfigDir: () => ".obsidian",
    getVaultConfigSyncRules: () => ({
      ...DEFAULT_VAULT_CONFIG_SYNC_RULES,
      enabled: true,
    }),
  });
});

afterEach(() => {
  fs.rmSync(temporary, { recursive: true, force: true });
});

it("excludes a linked configuration directory", async () => {
  fs.symlinkSync(outsidePath, path.join(vaultPath, ".obsidian"), "dir");
  await expect(source.listFiles()).resolves.toEqual([]);
});

it("supports missing configuration directories", async () => {
  expect(await source.listFiles()).toEqual([]);
});

it("checks config paths again when reading previously enumerated files", async () => {
  const config = path.join(vaultPath, ".obsidian");
  fs.mkdirSync(config);
  fs.writeFileSync(path.join(config, "app.json"), "{}");
  const files = await source.listFiles();
  expect(files.map((file) => file.path)).toEqual([".obsidian/app.json"]);
  expect(new TextDecoder().decode(await files[0]!.readBytes())).toBe("{}");

  fs.rmSync(config, { recursive: true });
  fs.symlinkSync(outsidePath, config, "dir");
  await expect(files[0]!.readBytes()).rejects.toThrow(
    /Unsafe vault path.*symlink/,
  );
});
