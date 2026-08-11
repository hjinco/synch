import type { Plugin } from "obsidian";

import { decodeBase64, encodeBase64 } from "@synch/sync-client/utils/bytes";

const REMOTE_VAULT_KEY_SECRET = "synch-remote-vault-key";

export interface StoredRemoteVaultKeySecret {
  remoteVaultKey: Uint8Array;
}

export async function readStoredRemoteVaultKeySecret(
  plugin: Plugin,
): Promise<StoredRemoteVaultKeySecret | null> {
  const raw =
    plugin.app.secretStorage.getSecret(REMOTE_VAULT_KEY_SECRET)?.trim() ?? "";
  if (!raw) {
    return null;
  }

  try {
    return {
      remoteVaultKey: decodeBase64(raw),
    };
  } catch {
    return null;
  }
}

export async function writeStoredRemoteVaultKeySecret(
  plugin: Plugin,
  secret: StoredRemoteVaultKeySecret,
): Promise<void> {
  plugin.app.secretStorage.setSecret(
    REMOTE_VAULT_KEY_SECRET,
    encodeBase64(secret.remoteVaultKey),
  );
}

export async function clearStoredRemoteVaultKeySecret(plugin: Plugin): Promise<void> {
  plugin.app.secretStorage.setSecret(REMOTE_VAULT_KEY_SECRET, "");
}
