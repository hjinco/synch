import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Reserved, never-synced vault-local directory used for CLI state. */
export const VAULT_STATE_DIR_NAME = ".synch";

export function resolveVaultPath(input: string | undefined): string {
  const resolved = path.resolve(input ?? process.cwd());
  try {
    // Resolve symlinks so the same vault always maps to one credentials
    // entry, lock file, and sync store regardless of how it was reached.
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function vaultStateDir(vaultPath: string): string {
  return path.join(vaultPath, VAULT_STATE_DIR_NAME);
}

export function vaultSyncStorePath(vaultPath: string): string {
  return path.join(vaultStateDir(vaultPath), "sync.sqlite");
}

export function vaultLockPath(vaultPath: string): string {
  return path.join(vaultStateDir(vaultPath), "cli.lock");
}

export function cliConfigDir(): string {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdgConfigHome || path.join(os.homedir(), ".config");
  return path.join(base, "synch");
}

export function cliCredentialsPath(): string {
  return path.join(cliConfigDir(), "credentials.json");
}
