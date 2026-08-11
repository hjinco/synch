import type { SyncConnectionStore } from "./ports";
import type { SyncConnection } from "./store";

export async function readStoredSyncConnection(
  store: SyncConnectionStore,
): Promise<SyncConnection | null> {
  return await store.readSyncConnection();
}

export async function writeStoredSyncConnection(
  store: SyncConnectionStore,
  connection: SyncConnection,
): Promise<void> {
  await store.writeSyncConnection(connection);
}

export async function getOrCreateStoredLocalVaultId(
  store: SyncConnectionStore,
  remoteVaultId: string,
): Promise<string> {
  const trimmedRemoteVaultId = remoteVaultId.trim();
  if (!trimmedRemoteVaultId) {
    throw new Error("Remote vault ID is required.");
  }

  const storedConnection = await readStoredSyncConnection(store);
  if (storedConnection) {
    if (storedConnection.remoteVaultId !== trimmedRemoteVaultId) {
      throw new Error("Local sync store belongs to a different remote vault.");
    }
    return storedConnection.localVaultId;
  }

  const createdLocalVaultId = await store.readLocalVaultId();
  await writeStoredSyncConnection(store, {
    localVaultId: createdLocalVaultId,
    remoteVaultId: trimmedRemoteVaultId,
    lastPulledCursor: 0,
  });
  return createdLocalVaultId;
}
