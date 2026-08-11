import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Exclusive per-vault process lock. Must be held before syncing (opening the
 * sync store for writes or starting file watching) so two CLI processes (or
 * a CLI and a future daemon) never sync the same vault concurrently.
 * Read-only inspection such as `synch status` may open the store without it.
 */
export class VaultLock {
  private released = false;

  private constructor(private readonly lockPath: string) {}

  static async acquire(lockPath: string): Promise<VaultLock> {
    await fs.mkdir(path.dirname(lockPath), { recursive: true });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await fs.open(lockPath, "wx");
        try {
          await handle.writeFile(
            `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
          );
        } finally {
          await handle.close();
        }
        return new VaultLock(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }

        const holderPid = await readLockHolderPid(lockPath);
        if (holderPid !== null && isProcessAlive(holderPid)) {
          throw new Error(
            `Another synch process (pid ${holderPid}) is already syncing this vault.`,
          );
        }

        // Stale lock from a dead process. Move it aside with an atomic
        // rename so only one contender removes it; a plain unlink could
        // delete a fresh lock another contender created after removing the
        // stale file itself.
        const stalePath = `${lockPath}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
        try {
          await fs.rename(lockPath, stalePath);
        } catch {
          // Another contender moved it first; retry the create.
          continue;
        }

        const capturedPid = await readLockHolderPid(stalePath);
        if (capturedPid !== null && isProcessAlive(capturedPid)) {
          // The stale file was replaced by a live holder's lock between the
          // read and the rename. Restore it (link never overwrites a newer
          // lock) and back off.
          await fs.link(stalePath, lockPath).catch(() => {});
          await fs.unlink(stalePath).catch(() => {});
          throw new Error(
            `Another synch process (pid ${capturedPid}) is already syncing this vault.`,
          );
        }

        await fs.unlink(stalePath).catch(() => {});
      }
    }

    throw new Error(`Unable to acquire vault lock at ${lockPath}.`);
  }

  async release(): Promise<void> {
    if (this.released) {
      return;
    }

    this.released = true;
    await fs.unlink(this.lockPath).catch(() => {});
  }
}

async function readLockHolderPid(lockPath: string): Promise<number | null> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown };
    return typeof parsed.pid === "number" ? parsed.pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
