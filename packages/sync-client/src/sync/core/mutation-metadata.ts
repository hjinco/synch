import type { PendingMutationRow } from "../store/store";
import type { SyncMetadataCryptoContext } from "./crypto";

export function metadataContextFromPendingMutation(
  mutation: Pick<PendingMutationRow, "entryId" | "baseRevision" | "op" | "blobId">,
): SyncMetadataCryptoContext {
  return {
    entryId: mutation.entryId,
    revision: mutation.baseRevision + 1,
    op: mutation.op,
    blobId: mutation.blobId,
  };
}
