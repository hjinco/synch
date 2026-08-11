import type { CliAppContext } from "../app/context";
import { describeError } from "../app/context";

export async function runSync(ctx: CliAppContext): Promise<number> {
  await ctx.initializeAuth();
  ctx.requireVerifiedAuth();
  await ctx.openVaultSession();

  ctx.logger.log(`Syncing ${ctx.vaultPath} ...`);
  const reconcile = await ctx.engine.reconcileOnce();
  await ctx.engine.waitForLocalMutationWork();
  ctx.logger.log(
    `Scanned ${reconcile.filesScanned} files (${reconcile.filesQueuedForUpsert} to upload, ${reconcile.filesQueuedForDelete} to delete).`,
  );

  await ctx.engine.startAutoSync();
  const drained = await ctx.engine.syncNow();
  const hasPending = await ctx.engine.hasPendingMutations();
  ctx.engine.stopAutoSync();

  if (!drained || hasPending) {
    const lastError = ctx.takeLastSyncError();
    ctx.logger.error(
      lastError
        ? `Sync did not complete: ${describeError(lastError)}`
        : "Sync did not complete; changes are still pending. Try again.",
    );
    return 1;
  }

  ctx.logger.log(
    `Sync complete (${ctx.syncProgress.completedEntries}/${ctx.syncProgress.totalEntries} entries).`,
  );
  return 0;
}
