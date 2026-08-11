import type { CommitMutationPayload } from "../remote/realtime-client";
import { SyncRealtimeError } from "../remote/realtime-client";
import type { PendingMutationRow } from "../store/store";
import type {
  PreparedPushMutation,
  SkippedPushMutation,
} from "./push-mutation-types";

export function toCommitPayload(mutation: {
  mutationId: string;
  entryId: string;
  op: "upsert" | "delete";
  baseRevision: number;
  blobId: string | null;
  encryptedMetadata: string;
}): CommitMutationPayload {
  return {
    mutationId: mutation.mutationId,
    entryId: mutation.entryId,
    op: mutation.op,
    baseRevision: mutation.baseRevision,
    blobId: mutation.blobId,
    encryptedMetadata: mutation.encryptedMetadata,
  };
}

export function metadataContextFromMutation(mutation: PendingMutationRow) {
  return {
    entryId: mutation.entryId,
    revision: mutation.baseRevision + 1,
    op: mutation.op,
    blobId: mutation.blobId,
  };
}

export function isSkippedPushMutation(
  value: PreparedPushMutation | SkippedPushMutation,
): value is SkippedPushMutation {
  return "skipped" in value;
}

export interface StaleRevisionLike {
  code: string;
  expectedBaseRevision?: number;
  receivedBaseRevision?: number;
  details?: {
    expectedBaseRevision?: number;
    receivedBaseRevision?: number;
  };
}

export function isPullResolvableStaleRevision(error: unknown): boolean {
  const revisions = staleRevisionNumbers(error);
  return revisions !== null && revisions.expectedBaseRevision > revisions.receivedBaseRevision;
}

export function isLocalAheadStaleRevision(error: unknown): error is StaleRevisionLike {
  const revisions = staleRevisionNumbers(error);
  return revisions !== null && revisions.expectedBaseRevision < revisions.receivedBaseRevision;
}

function staleRevisionNumbers(
  error: unknown,
): { expectedBaseRevision: number; receivedBaseRevision: number } | null {
  if (!isStaleRevisionLike(error)) {
    return null;
  }

  const expectedBaseRevision =
    error.expectedBaseRevision ?? error.details?.expectedBaseRevision;
  const receivedBaseRevision =
    error.receivedBaseRevision ?? error.details?.receivedBaseRevision;
  if (
    typeof expectedBaseRevision !== "number" ||
    typeof receivedBaseRevision !== "number"
  ) {
    return null;
  }

  return { expectedBaseRevision, receivedBaseRevision };
}

function isStaleRevisionLike(error: unknown): error is StaleRevisionLike {
  if (error instanceof SyncRealtimeError) {
    return error.code === "stale_revision";
  }

  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "stale_revision"
  );
}
