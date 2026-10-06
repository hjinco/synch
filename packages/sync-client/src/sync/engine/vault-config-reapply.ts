import { retrySyncStateWork, syncStateCoordinator, withSyncState } from "./sync-state-coordinator";
import type { SyncContentRuntimeDeps } from "../core/content-runtime";
import { decryptSyncBlob } from "../core/crypto";
import { isPortableVaultPath } from "../core/portable-path";
import {
  shouldSyncVaultConfigPath,
  type VaultConfigSyncRules,
} from "../core/vault-config-rules";
import type { SyncEventGate } from "./event-gate";
import type { SyncBlobClient } from "../remote/blob-client";
import type { SyncTokenResponse } from "../remote/client";
import type { SyncStore } from "../store/store";
import type { SyncVaultWriter } from "../vault/vault-writer";
import {
  removeVaultPathIfExists,
  writeVaultBytes,
} from "../vault/vault-writer";

export interface ReapplyRemoteVaultConfigDeps extends SyncContentRuntimeDeps {
  store: SyncStore;
  rules: VaultConfigSyncRules;
  configDir: string;
  vaultWriter: SyncVaultWriter;
  eventGate: SyncEventGate;
  blobClient: Pick<SyncBlobClient, "downloadBlob">;
  getSyncToken: () => Promise<SyncTokenResponse>;
  getRemoteVaultKey: () => Uint8Array;
}

export async function reapplyAllowedRemoteVaultConfig(
  deps: ReapplyRemoteVaultConfigDeps,
): Promise<number> {
  const contentRuntime = deps.contentRuntime;
  const { store, rules } = deps;
  if (!rules.enabled) {
    return 0;
  }

  const remotes = (await store.listRemoteStates()).filter(
    (entry) =>
      entry.path &&
      isPortableVaultPath(entry.path) &&
      shouldSyncVaultConfigPath(entry.path, rules, deps.configDir),
  );
  if (remotes.length === 0) {
    return 0;
  }

  const token = await deps.getSyncToken();
  let applied = 0;
  for (const candidate of remotes) {
    applied += await retrySyncStateWork(async () => {
      const snapshot = syncStateCoordinator(store).watch();
      try {
        const remote = await store.getRemoteStateById(candidate.entryId);
        if (!remote?.path || !isPortableVaultPath(remote.path) ||
            !shouldSyncVaultConfigPath(remote.path, rules, deps.configDir)) return 0;
        if (await store.getDirtyEntryMutation(remote.entryId)) return 0;
        const local = await store.getLocalStateById(remote.entryId);
        const current = local ? await store.getEntryById(remote.entryId) : null;
        if (local && current && local.deleted === remote.deleted &&
            current.revision === remote.revision && current.blobId === remote.blobId &&
            current.hash === remote.hash) return 0;

        let encryptedBytes: Uint8Array | null = null;
        let bytes: Uint8Array | null = null;
        if (!remote.deleted) {
          if (!remote.blobId) return 0;
          encryptedBytes = await deps.blobClient.downloadBlob(token.vaultId, remote.blobId);
          const hashed = await contentRuntime.hashAndReturnBytes(await decryptSyncBlob(
            deps.getRemoteVaultKey(), encryptedBytes, { blobId: remote.blobId },
          ));
          bytes = hashed.bytes;
          if (hashed.hash !== remote.hash) {
            throw new Error(`Remote vault config ${remote.entryId}@${remote.revision} hash does not match metadata.`);
          }
        }

        const path = remote.path;
        return await withSyncState(store, { entryIds: [remote.entryId], paths: [path] }, async () =>
          await deps.eventGate.suppressPaths([path], async () => {
            if (remote.deleted) await removeVaultPathIfExists(deps.vaultWriter, path);
            else await writeVaultBytes(deps.vaultWriter, path, bytes!);
            await store.upsertEntry({
              entryId: remote.entryId, path, revision: remote.revision,
              blobId: remote.deleted ? null : remote.blobId, hash: remote.hash,
              deleted: remote.deleted, updatedAt: remote.updatedAt,
              localMtime: null, localSize: null,
            });
            if (encryptedBytes && remote.blobId) {
              await store.putBlob({
                blobId: remote.blobId, hash: remote.hash, encryptedBytes,
                role: "remote", refEntryId: remote.entryId, cachedAt: Date.now(),
              });
            }
            return 1;
          }), snapshot,
        );
      } finally {
        snapshot.dispose();
      }
    });
  }
  return applied;
}
