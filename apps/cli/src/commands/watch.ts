import type { CliAppContext } from "../app/context";
import { describeError } from "../app/context";
import { formatSyncStatusLabel } from "../app/notices";

export async function runWatch(ctx: CliAppContext): Promise<number> {
  await ctx.initializeAuth();
  ctx.requireVerifiedAuth();
  await ctx.openVaultSession();

  let lastPrinted = "";
  ctx.onSyncStatusChange = () => {
    const progress =
      ctx.syncStatus === "syncing" && ctx.syncProgress.totalEntries > 0
        ? ` (${ctx.syncProgress.completedEntries}/${ctx.syncProgress.totalEntries})`
        : "";
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
  await ctx.engine.startAutoSync();
  await ctx.engine.syncNow();
  ctx.logger.log("Watching for changes. Press Ctrl+C to stop.");

  await waitForShutdownSignal();
  ctx.logger.log("Stopping...");
  return 0;
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const onSignal = () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolve();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}
