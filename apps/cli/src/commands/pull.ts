import type { CliAppContext } from "../app/context";

export async function runPull(ctx: CliAppContext): Promise<number> {
  await ctx.initializeAuth();
  ctx.requireVerifiedAuth();
  await ctx.openVaultSession();

  ctx.logger.log(`Pulling remote changes into ${ctx.vaultPath} ...`);
  await ctx.engine.pullOnlyOnce();
  ctx.logger.log(
    `Pull complete (${ctx.syncProgress.completedEntries}/${ctx.syncProgress.totalEntries} entries).`,
  );
  return 0;
}
