import type { SyncConnectionStore } from "./ports";

export async function getOrCreateStoredLocalVaultId(
  store: SyncConnectionStore,
  remoteVaultId: string,
): Promise<string> {
  const trimmedRemoteVaultId = remoteVaultId.trim();
  if (!trimmedRemoteVaultId) {
    throw new Error("Remote vault ID is required.");
  }

  const storedConnection = await store.readSyncConnection();
  if (storedConnection) {
    if (storedConnection.remoteVaultId !== trimmedRemoteVaultId) {
      throw new Error("Local sync store belongs to a different remote vault.");
    }
    return storedConnection.localVaultId;
  }

  const createdLocalVaultId = await store.readLocalVaultId();
  await store.writeSyncConnection({
    localVaultId: createdLocalVaultId,
    remoteVaultId: trimmedRemoteVaultId,
    lastPulledCursor: 0,
  });
  return createdLocalVaultId;
}
