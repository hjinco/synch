import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CliAppContext } from "../app/context";
import { runWatch } from "./watch";

const scanResult = { filesScanned: 0, filesQueuedForUpsert: 0, filesQueuedForDelete: 0 };
let temporary: string;
let ctx: CliAppContext;
let running: Promise<number> | undefined;

beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), "synch-watch-command-"));
  ctx = new CliAppContext({
    vaultPath: temporary,
    credentialsPath: path.join(temporary, "credentials.json"),
    logger: { log: vi.fn(), error: vi.fn() },
  });
  vi.spyOn(ctx, "initializeAuth").mockResolvedValue({ state: "verified", token: "test-token" });
  vi.spyOn(ctx, "requireVerifiedAuth").mockImplementation(() => {});
  vi.spyOn(ctx, "openVaultSession").mockResolvedValue();
  vi.spyOn(ctx.engine, "registerVaultEvents").mockImplementation(() => {});
  vi.spyOn(ctx.engine, "reconcileOnce").mockResolvedValue(scanResult);
  vi.spyOn(ctx.engine, "startAutoSync").mockResolvedValue(true);
  vi.spyOn(ctx.engine, "syncNow").mockResolvedValue(true);
  vi.spyOn(ctx.engine, "notifyLocalChange").mockImplementation(() => {});
});

afterEach(async () => {
  ctx.onSyncTerminalStop?.({ type: "sync_paused", error: new Error("paused") });
  await running?.catch(() => {});
  await ctx.close();
  vi.restoreAllMocks();
  fs.rmSync(temporary, { recursive: true, force: true });
  running = undefined;
});

async function startWatching() {
  running = runWatch(ctx);
  await vi.waitFor(() => expect(ctx.logger.log).toHaveBeenCalledWith(
    "Watching for changes. Press Ctrl+C to stop.",
  ));
}

describe("watch command", () => {
  it("coalesces requests arriving during a scan into a subsequent scan", async () => {
    await startWatching();
    const scan = Promise.withResolvers<void>();
    vi.mocked(ctx.engine.reconcileOnce).mockImplementationOnce(async () => {
      await scan.promise;
      return scanResult;
    });

    try {
      ctx.onReconcileRequested?.();
      await vi.waitFor(() => expect(ctx.engine.reconcileOnce).toHaveBeenCalledTimes(2));
      ctx.onReconcileRequested?.();
      ctx.onReconcileRequested?.();
      expect(ctx.engine.reconcileOnce).toHaveBeenCalledTimes(2);

      scan.resolve();
      await vi.waitFor(() => expect(ctx.engine.reconcileOnce).toHaveBeenCalledTimes(3));
      expect(ctx.engine.notifyLocalChange).toHaveBeenCalledTimes(2);
    } finally {
      scan.resolve();
    }
  });

  it("retries a request queued during a failed scan without losing it", async () => {
    await startWatching();
    const scan = Promise.withResolvers<void>();
    vi.mocked(ctx.engine.reconcileOnce).mockImplementationOnce(async () => {
      await scan.promise;
      throw new Error("temporary I/O failure");
    });

    try {
      ctx.onReconcileRequested?.();
      await vi.waitFor(() => expect(ctx.engine.reconcileOnce).toHaveBeenCalledTimes(2));
      ctx.onReconcileRequested?.();
      scan.resolve();

      await vi.waitFor(() => expect(ctx.engine.reconcileOnce).toHaveBeenCalledTimes(3));
      expect(ctx.logger.error).toHaveBeenCalledExactlyOnceWith("reconcile failed: temporary I/O failure");
      expect(ctx.engine.notifyLocalChange).toHaveBeenCalledTimes(1);
    } finally {
      scan.resolve();
    }
  });

  it("waits for an active scan on shutdown and drops queued rescans", async () => {
    await startWatching();
    const scan = Promise.withResolvers<void>();
    vi.mocked(ctx.engine.reconcileOnce).mockImplementationOnce(async () => {
      await scan.promise;
      return scanResult;
    });
    let finished = false;
    void running!.then(() => { finished = true; });

    try {
      ctx.onReconcileRequested?.();
      await vi.waitFor(() => expect(ctx.engine.reconcileOnce).toHaveBeenCalledTimes(2));
      ctx.onReconcileRequested?.();
      ctx.onSyncTerminalStop?.({ type: "sync_paused", error: new Error("paused") });
      await vi.waitFor(() => expect(ctx.onReconcileRequested).toBeNull());
      expect(finished).toBe(false);

      scan.resolve();
      await expect(running).resolves.toBe(1);
      expect(ctx.engine.reconcileOnce).toHaveBeenCalledTimes(2);
      expect(ctx.engine.notifyLocalChange).not.toHaveBeenCalled();
    } finally {
      scan.resolve();
    }
  });

  it("cleans up callbacks when the initial scan fails before networking starts", async () => {
    const error = new Error("scan failed");
    vi.mocked(ctx.engine.reconcileOnce).mockRejectedValue(error);

    await expect(runWatch(ctx)).rejects.toBe(error);

    expect(ctx.engine.startAutoSync).not.toHaveBeenCalled();
    expect(ctx.engine.syncNow).not.toHaveBeenCalled();
    expect(ctx.onReconcileRequested).toBeNull();
    expect(ctx.onSyncStatusChange).toBeNull();
    expect(ctx.onSyncTerminalStop).toBeNull();
  });

  it("exits on a terminal startup failure without announcing watch readiness", async () => {
    vi.mocked(ctx.engine.startAutoSync).mockImplementation(async () => {
      ctx.onSyncTerminalStop?.({ type: "storage_quota_exceeded" });
      return false;
    });

    await expect(runWatch(ctx)).resolves.toBe(1);
    expect(ctx.logger.log).not.toHaveBeenCalledWith("Watching for changes. Press Ctrl+C to stop.");
    expect(ctx.onReconcileRequested).toBeNull();
  });

  it.each(["SIGINT", "SIGTERM"] as const)("removes its %s listener after a normal shutdown", async (signal) => {
    const previousListeners = process.listeners(signal);
    await startWatching();

    process.emit(signal);

    await expect(running).resolves.toBe(0);
    expect(process.listeners(signal)).toEqual(previousListeners);
    expect(ctx.onReconcileRequested).toBeNull();
    expect(ctx.onSyncStatusChange).toBeNull();
    expect(ctx.onSyncTerminalStop).toBeNull();
  });
});
