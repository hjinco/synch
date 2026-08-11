import fs from "node:fs";

import type { CliAppContext } from "../app/context";
import { vaultSyncStorePath } from "../host/paths";
import { SqliteSyncStore } from "../host/sqlite-store";

export async function runStatus(ctx: CliAppContext): Promise<number> {
  await ctx.initializeAuth();

  const out = (line: string) => process.stdout.write(`${line}\n`);
  out(`Vault: ${ctx.vaultPath}`);
  out(`API server: ${ctx.apiBaseUrl}`);
  out(`Account: ${formatAccount(ctx)}`);

  const credential = ctx.credentials.getVaultCredential(ctx.vaultPath);
  if (!credential) {
    out("Remote vault: not connected (run `synch vault connect`)");
    return 0;
  }
  out(`Remote vault: ${credential.remoteVaultId}`);

  const dbPath = vaultSyncStorePath(ctx.vaultPath);
  if (!fs.existsSync(dbPath)) {
    out("Local sync state: not initialized");
    return 0;
  }

  // Deliberately opened without the vault lock so `status` works while a
  // `watch` process runs. Reads are safe under WAL with busy_timeout, and
  // open() only performs idempotent schema setup on an existing database.
  const store = SqliteSyncStore.open(dbPath);
  try {
    const connection = await store.readSyncConnection();
    const progress = await store.countSyncProgress();
    const pending = await store.listDirtyEntries(1);
    out(`Local vault ID: ${connection?.localVaultId ?? (await store.readLocalVaultId())}`);
    out(`Last pulled cursor: ${connection?.lastPulledCursor ?? 0}`);
    out(`Entries: ${progress.completedEntries}/${progress.totalEntries} synced`);
    out(`Pending local changes: ${pending.length > 0 ? "yes" : "no"}`);
  } finally {
    await store.close();
  }

  return 0;
}

function formatAccount(ctx: CliAppContext): string {
  const status = ctx.authManager.getAuthStatus();
  switch (status.state) {
    case "signed_in":
      return `signed in as ${status.displayName}`;
    case "pending_network":
      return "stored session (network unreachable)";
    case "needs_relogin":
      return "session rejected; run `synch login`";
    case "not_signed_in":
      return "not signed in";
  }
}
