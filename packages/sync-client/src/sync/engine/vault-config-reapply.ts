import { hashBytes } from "../core/content";
import { decryptSyncBlob } from "../core/crypto";
import {
  shouldSyncVaultConfigPath,
  type VaultConfigSyncRules,
} from "../core/vault-config-rules";
import type { SyncEventGate } from "./event-gate";
import type { SyncPullClient } from "../remote/pull-client";
import type { SyncTokenResponse } from "../remote/client";
import type { SyncStore } from "../store/store";
import type { SyncVaultWriter } from "../vault/vault-writer";
import {
  removeVaultPathIfExists,
  writeVaultBytes,
} from "../vault/vault-writer";

export interface ReapplyRemoteVaultConfigDeps {
  store: SyncStore;
  rules: VaultConfigSyncRules;
  configDir: string;
  vaultWriter: SyncVaultWriter;
  eventGate: SyncEventGate;
  pullClient: SyncPullClient;
  getApiBaseUrl: () => string;
  getSyncToken: () => Promise<SyncTokenResponse>;
  getRemoteVaultKey: () => Uint8Array;
}

export async function reapplyAllowedRemoteVaultConfig(
  deps: ReapplyRemoteVaultConfigDeps,
): Promise<number> {
  const { store, rules } = deps;
  if (!rules.enabled) {
    return 0;
  }

  const remotes = (await store.listRemoteStates()).filter(
    (entry) =>
      entry.path &&
      shouldSyncVaultConfigPath(entry.path, rules, deps.configDir),
  );
  if (remotes.length === 0) {
    return 0;
  }

  const token = await deps.getSyncToken();
  let applied = 0;
  await deps.eventGate.suppressPaths(
    remotes.map((entry) => entry.path).filter((path): path is string => !!path),
    async () => {
      for (const remote of remotes) {
        if (!remote.path) {
          continue;
        }

        if (await store.getDirtyEntryMutation(remote.entryId)) {
          continue;
        }

        const local = await store.getLocalStateById(remote.entryId);
        const current = local
          ? await store.getEntryById(remote.entryId)
          : null;
        if (
          local &&
          current &&
          local.deleted === remote.deleted &&
          current.revision === remote.revision &&
          current.blobId === remote.blobId &&
          current.hash === remote.hash
        ) {
          continue;
        }

        if (remote.deleted) {
          await removeVaultPathIfExists(deps.vaultWriter, remote.path);
          await store.upsertEntry({
            entryId: remote.entryId,
            path: remote.path,
            revision: remote.revision,
            blobId: null,
            hash: remote.hash,
            deleted: true,
            updatedAt: remote.updatedAt,
            localMtime: null,
            localSize: null,
          });
          applied += 1;
          continue;
        }

        if (!remote.blobId) {
          continue;
        }

        const encryptedBytes = await deps.pullClient.downloadBlob(
          deps.getApiBaseUrl(),
          token.token,
          token.vaultId,
          remote.blobId,
        );
        const bytes = await decryptSyncBlob(
          deps.getRemoteVaultKey(),
          encryptedBytes,
          { blobId: remote.blobId },
          { syncFormatVersion: token.syncFormatVersion },
        );
        const actualHash = await hashBytes(bytes);
        if (actualHash !== remote.hash) {
          throw new Error(
            `Remote vault config ${remote.entryId}@${remote.revision} hash does not match metadata.`,
          );
        }

        await writeVaultBytes(deps.vaultWriter, remote.path, bytes);
        await store.upsertEntry({
          entryId: remote.entryId,
          path: remote.path,
          revision: remote.revision,
          blobId: remote.blobId,
          hash: remote.hash,
          deleted: false,
          updatedAt: remote.updatedAt,
          localMtime: null,
          localSize: null,
        });
        await store.putBlob({
          blobId: remote.blobId,
          hash: remote.hash,
          encryptedBytes,
          role: "remote",
          refEntryId: remote.entryId,
          cachedAt: Date.now(),
        });
        applied += 1;
      }
    },
  );
  await store.flush();
  return applied;
}
