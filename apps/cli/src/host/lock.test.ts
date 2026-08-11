import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { VaultLock } from "./lock";

let tempDir: string;
let lockPath: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synch-lock-"));
  lockPath = path.join(tempDir, ".synch", "cli.lock");
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("VaultLock", () => {
  it("acquires and releases the lock", async () => {
    const lock = await VaultLock.acquire(lockPath);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid).toBe(process.pid);

    await lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("refuses a second acquisition while the holder is alive", async () => {
    const lock = await VaultLock.acquire(lockPath);
    await expect(VaultLock.acquire(lockPath)).rejects.toThrow(
      `Another synch process (pid ${process.pid})`,
    );
    await lock.release();
  });

  it("reclaims a stale lock from a dead process", async () => {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: 2 ** 30, createdAt: new Date().toISOString() }),
    );

    const lock = await VaultLock.acquire(lockPath);
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
    await lock.release();
  });

  it("reclaims a corrupted lock file", async () => {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "not json");

    const lock = await VaultLock.acquire(lockPath);
    await lock.release();
  });

  it("allows reacquisition after release", async () => {
    const first = await VaultLock.acquire(lockPath);
    await first.release();
    const second = await VaultLock.acquire(lockPath);
    await second.release();
  });
});
