import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";

import type { AuthSessionTokenStore } from "@synch/sync-client/auth";
import type { StoredRemoteVaultKeySecret } from "@synch/sync-client/remote";

interface StoredVaultCredential {
  remoteVaultId: string;
  remoteVaultKeyBase64: string;
}

interface CredentialsFile {
  version: 1;
  sessionToken?: string;
  /** Keyed by the vault directory's absolute path. */
  vaults?: Record<string, StoredVaultCredential>;
}

/**
 * File-backed credential store (session token + per-vault key bytes).
 * Secrets live outside the vault, in the CLI config directory, with 0600
 * permissions. State is cached in memory because the sync-client vault
 * manager reads credentials through synchronous getters.
 */
export class CliCredentialsStore {
  private state: CredentialsFile;

  constructor(private readonly filePath: string) {
    this.state = this.load();
  }

  getSessionToken(): string {
    return this.state.sessionToken ?? "";
  }

  async setSessionToken(token: string): Promise<void> {
    if (token) {
      this.state.sessionToken = token;
    } else {
      delete this.state.sessionToken;
    }
    await this.persist();
  }

  getVaultCredential(vaultPath: string): {
    remoteVaultId: string;
    secret: StoredRemoteVaultKeySecret;
  } | null {
    const record = this.state.vaults?.[vaultPath];
    if (!record?.remoteVaultId || !record.remoteVaultKeyBase64) {
      return null;
    }

    return {
      remoteVaultId: record.remoteVaultId,
      secret: {
        remoteVaultKey: new Uint8Array(
          Buffer.from(record.remoteVaultKeyBase64, "base64"),
        ),
      },
    };
  }

  async saveVaultCredential(
    vaultPath: string,
    remoteVaultId: string,
    secret: StoredRemoteVaultKeySecret,
  ): Promise<void> {
    this.state.vaults ??= {};
    this.state.vaults[vaultPath] = {
      remoteVaultId,
      remoteVaultKeyBase64: Buffer.from(secret.remoteVaultKey).toString("base64"),
    };
    await this.persist();
  }

  async clearVaultCredential(vaultPath: string): Promise<void> {
    if (!this.state.vaults?.[vaultPath]) {
      return;
    }

    delete this.state.vaults[vaultPath];
    await this.persist();
  }

  async clearAllVaultCredentials(): Promise<void> {
    delete this.state.vaults;
    await this.persist();
  }

  createSessionTokenStore(): AuthSessionTokenStore {
    return {
      read: async () => this.getSessionToken(),
      write: async (token) => {
        await this.setSessionToken(token);
      },
      clear: async () => {
        await this.setSessionToken("");
      },
    };
  }

  private load(): CredentialsFile {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch {
      // A missing file starts a fresh credentials store.
      return { version: 1 };
    }

    try {
      const parsed = JSON.parse(raw) as CredentialsFile;
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {
      // Fall through to preserving the unreadable file below.
    }

    // The file holds the session token and vault keys; move it aside for
    // manual recovery instead of silently overwriting it on the next write.
    try {
      fs.renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
    } catch {
      // Keep going with a fresh store even if the backup rename fails.
    }
    return { version: 1 };
  }

  private async persist(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fsPromises.mkdir(dir, { recursive: true, mode: 0o700 });
    // Process-unique temp name so concurrent CLI processes sharing the
    // credentials file never interleave a write and a rename.
    const tempPath = `${this.filePath}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
    try {
      await fsPromises.writeFile(
        tempPath,
        `${JSON.stringify(this.state, null, 2)}\n`,
        { mode: 0o600 },
      );
      await fsPromises.rename(tempPath, this.filePath);
    } catch (error) {
      await fsPromises.unlink(tempPath).catch(() => {});
      throw error;
    }
    await fsPromises.chmod(this.filePath, 0o600);
  }
}
