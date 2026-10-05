import type { SyncTerminalStopReason } from "@synch/sync-client/engine";
import type { CliAppContext } from "../app/context";
import { describeError } from "../app/context";
import { formatSyncProgressSuffix, formatSyncStatusLabel } from "../app/notices";

export async function runWatch(ctx: CliAppContext): Promise<number> {
  await ctx.initializeAuth();
  ctx.requireVerifiedAuth();
  await ctx.openVaultSession();

  let lastPrinted = "";
  ctx.onSyncStatusChange = () => {
    const progress =
      ctx.syncStatus === "syncing" ? formatSyncProgressSuffix(ctx.syncProgress) : "";
    const line = `status: ${formatSyncStatusLabel(ctx.syncStatus)}${progress}`;
    if (line !== lastPrinted) {
      lastPrinted = line;
      ctx.logger.log(line);
    }
  };

  let reconcilePromise: Promise<void> | null = null;
  ctx.onReconcileRequested = () => {
    if (reconcilePromise) {
      return;
    }
    reconcilePromise = (async () => {
      try {
        const result = await ctx.engine.reconcileOnce();
        if (result.filesQueuedForUpsert > 0 || result.filesQueuedForDelete > 0) {
          ctx.engine.notifyLocalChange();
        }
      } catch (error) {
        ctx.logger.error(`reconcile failed: ${describeError(error)}`);
      } finally {
        reconcilePromise = null;
      }
    })();
  };

  ctx.logger.log(`Watching ${ctx.vaultPath}`);
  ctx.engine.registerVaultEvents();
  await ctx.engine.reconcileOnce();
  await ctx.engine.waitForLocalMutationWork();
  const watchEnd = waitForWatchEnd(ctx);
  try {
    await ctx.engine.startAutoSync();
    await ctx.engine.syncNow();
    if (watchEnd.isSettled()) {
      const result = await watchEnd.promise;
      if (result.kind === "terminal_stop") {
        return reportTerminalStop(ctx, result.reason);
      }
      ctx.logger.log("Stopping...");
      return 0;
    }

    watchEnd.listenForShutdownSignals();
    ctx.logger.log("Watching for changes. Press Ctrl+C to stop.");
    const result = await watchEnd.promise;
    if (result.kind === "signal") {
      ctx.logger.log("Stopping...");
      return 0;
    }
    return reportTerminalStop(ctx, result.reason);
  } finally {
    watchEnd.dispose();
    ctx.onSyncTerminalStop = null;
  }
}

type WatchEndResult =
  | { kind: "signal" }
  | { kind: "terminal_stop"; reason: SyncTerminalStopReason };

function waitForWatchEnd(ctx: CliAppContext): {
  promise: Promise<WatchEndResult>;
  isSettled: () => boolean;
  listenForShutdownSignals: () => void;
  dispose: () => void;
} {
  let settled = false;
  let resolveResult: (result: WatchEndResult) => void = () => {};
  const promise = new Promise<WatchEndResult>((resolve) => {
    resolveResult = resolve;
  });
  const finish = (result: WatchEndResult) => {
    if (settled) {
      return;
    }
    settled = true;
    resolveResult(result);
  };
  const onSignal = () => finish({ kind: "signal" });
  ctx.onSyncTerminalStop = (reason) => finish({ kind: "terminal_stop", reason });
  let listeningForSignals = false;

  return {
    promise,
    isSettled: () => settled,
    listenForShutdownSignals: () => {
      if (listeningForSignals) {
        return;
      }
      listeningForSignals = true;
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
    },
    dispose: () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    },
  };
}

function reportTerminalStop(ctx: CliAppContext, reason: SyncTerminalStopReason): 1 {
  switch (reason.type) {
    case "remote_vault_unavailable":
      ctx.logger.error(
        `Sync stopped: remote vault is unavailable (${reason.error.reason}): ${describeError(reason.error)}`,
      );
      return 1;
    case "sync_history_mismatch":
      // The engine already reports the detailed history mismatch error.
      ctx.logger.error("Watch stopped because sync cannot continue with this history.");
      return 1;
    case "sync_paused":
      ctx.logger.error("Watch stopped because the server paused sync. The vault connection is preserved; restart `synch watch` to retry.");
      return 1;
    case "storage_quota_exceeded":
      ctx.logger.error(
        "Sync stopped: remote vault storage quota exceeded. Free space in the remote vault, then restart `synch watch`.",
      );
      return 1;
  }
}
