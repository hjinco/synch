import type { SyncConnection } from "@synch/sync-client/sync/store/store";
import type { MetadataRecord } from "./records";

export function toSyncConnection(
  localVaultId: string,
  metadata: MetadataRecord | null | undefined,
): SyncConnection | null {
  const remoteVaultId = metadata?.remoteVaultId?.trim() ?? "";
  if (!localVaultId || !remoteVaultId) {
    return null;
  }

  return {
    localVaultId,
    remoteVaultId,
    lastPulledCursor: metadata?.lastPulledCursor ?? 0,
  };
}
