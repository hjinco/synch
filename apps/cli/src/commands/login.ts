import type { CliAppContext } from "../app/context";

export async function runLogin(ctx: CliAppContext): Promise<number> {
  const readiness = await ctx.initializeAuth();
  if (readiness.state === "verified") {
    const status = ctx.authManager.getAuthStatus();
    const who = status.state === "signed_in" ? ` as ${status.displayName}` : "";
    ctx.logger.log(`Already signed in${who}.`);
    return 0;
  }

  await ctx.authManager.beginDeviceLogin();
  return ctx.authManager.hasAuthenticatedSession() ? 0 : 1;
}
