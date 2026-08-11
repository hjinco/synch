import type { CliAppContext } from "../app/context";
import { describeError } from "../app/context";

export async function runLogout(ctx: CliAppContext): Promise<number> {
  await ctx.initializeAuth();

  try {
    await ctx.authManager.signOutDevice();
  } catch (error) {
    // The local session is cleared even when the server sign-out fails.
    ctx.logger.log(`Server sign-out failed (${describeError(error)}); local session cleared.`);
  }

  ctx.remoteVaultManager.clearSession();
  await ctx.credentials.clearAllVaultCredentials();
  ctx.logger.log("Cleared stored vault keys.");
  return 0;
}
