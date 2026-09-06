import type { Plugin } from "obsidian";

import { decodeBase64, encodeBase64 } from "@synch/vault-crypto";
import type { StoredRemoteVaultKeySecret } from "@synch/sync-client/remote";
import { getOrCreateSecretScopeId } from "./secret-scope";

export type { StoredRemoteVaultKeySecret };

const LEGACY_REMOTE_VAULT_KEY_SECRET = "synch-remote-vault-key";

function remoteVaultKeySecretName(secretScopeId: string): string {
  return `${LEGACY_REMOTE_VAULT_KEY_SECRET}-${secretScopeId}`;
}

export async function migrateLegacyRemoteVaultKeySecret(
  plugin: Plugin,
): Promise<void> {
  try {
    const secretScopeId = getOrCreateSecretScopeId(plugin);
    const scopedSecretName = remoteVaultKeySecretName(secretScopeId);
    const scopedRaw = plugin.app.secretStorage.getSecret(scopedSecretName)?.trim() ?? "";
    if (decodeStoredRemoteVaultKey(scopedRaw)) {
      plugin.app.secretStorage.setSecret(LEGACY_REMOTE_VAULT_KEY_SECRET, "");
      return;
    }

    const legacyRaw =
      plugin.app.secretStorage.getSecret(LEGACY_REMOTE_VAULT_KEY_SECRET)?.trim() ?? "";
    const legacySecret = decodeStoredRemoteVaultKey(legacyRaw);
    if (!legacySecret) {
      return;
    }

    plugin.app.secretStorage.setSecret(
      scopedSecretName,
      encodeBase64(legacySecret.remoteVaultKey),
    );
    plugin.app.secretStorage.setSecret(LEGACY_REMOTE_VAULT_KEY_SECRET, "");
  } catch {
    // Leave the legacy secret untouched if copying fails so the next plugin
    // start can retry without losing the existing vault key.
  }
}

export async function readStoredRemoteVaultKeySecret(
  plugin: Plugin,
): Promise<StoredRemoteVaultKeySecret | null> {
  try {
    const secretScopeId = getOrCreateSecretScopeId(plugin);
    const scopedSecretName = remoteVaultKeySecretName(secretScopeId);
    const scopedRaw = plugin.app.secretStorage.getSecret(scopedSecretName)?.trim() ?? "";
    return decodeStoredRemoteVaultKey(scopedRaw);
  } catch {
    return null;
  }
}

export async function writeStoredRemoteVaultKeySecret(
  plugin: Plugin,
  secret: StoredRemoteVaultKeySecret,
): Promise<void> {
  const secretScopeId = getOrCreateSecretScopeId(plugin);
  plugin.app.secretStorage.setSecret(
    remoteVaultKeySecretName(secretScopeId),
    encodeBase64(secret.remoteVaultKey),
  );
  plugin.app.secretStorage.setSecret(LEGACY_REMOTE_VAULT_KEY_SECRET, "");
}

export async function clearStoredRemoteVaultKeySecret(plugin: Plugin): Promise<void> {
  const secretScopeId = getOrCreateSecretScopeId(plugin);
  plugin.app.secretStorage.setSecret(remoteVaultKeySecretName(secretScopeId), "");
  plugin.app.secretStorage.setSecret(LEGACY_REMOTE_VAULT_KEY_SECRET, "");
}

function decodeStoredRemoteVaultKey(
  raw: string,
): StoredRemoteVaultKeySecret | null {
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
