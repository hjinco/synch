import type { SyncedEntryMetadata } from "../core/content";
import type { RemoteEntryState } from "../remote/changes";
import type {
  LocalSyncEntryRow,
  PendingMutationRow,
  RemoteSyncEntryRow,
  SyncEntryRow,
} from "../store/store";

export const DEFAULT_PREPARE_CONCURRENCY = 25;

export interface PullConflictEvent {
  entryId: string;
  op: "upsert" | "delete";
  reason: "local_pending_mutation" | "remote_path_collision";
  originalPath: string;
  conflictPath: string | null;
}

/** A manifest item whose revision is older than what's already known locally - see the check in `PullManifestPlanner`. */
export interface PullRollbackEvent {
  entryId: string;
  path: string | null;
  localRevision: number;
  remoteRevision: number;
}

export type PullEntryStateManifestItem = {
  state: RemoteEntryState;
  metadata: SyncedEntryMetadata;
};

export type PlannedEntryState = {
  state: RemoteEntryState;
  existing: SyncEntryRow | null;
  adoptedLocalEntry: AdoptedLocalEntry | null;
  vaultMove: PlannedVaultMove | null;
  skipVaultWrite: boolean;
  metadata: SyncedEntryMetadata;
  finalPath: string | null;
  hash: string | null;
  pathConflict: PullConflictEvent | null;
  pendingConflict: PullConflictEvent | null;
  supersededPathOwner: SyncEntryRow | null;
};

export type PlannedVaultMove = {
  from: string;
  to: string;
};

export type AdoptedLocalEntry = {
  entry: SyncEntryRow;
  pending: PendingMutationRow;
  hashMatches: boolean;
};

export type PreparedEntryBlob = {
  plan: PlannedEntryState;
  bytes: Uint8Array;
};

export type PreparedPendingMerge =
  | {
      kind: "local";
      bytes: Uint8Array;
      blobId: string;
      hash: string;
      encryptedMetadata: string;
      path: string;
    }
  | {
      kind: "remote";
    };

export type PreparedPendingConflict = {
  plan: PlannedEntryState;
  pending: PendingMutationRow;
  event: PullConflictEvent | null;
  conflictBytes: Uint8Array | null;
  merge: PreparedPendingMerge | null;
};

export type PreparedPathBatch = {
  plans: PlannedEntryState[];
  pathsToRemove: string[];
  blobs: PreparedEntryBlob[];
};

export type PreparedManifestApplication = {
  completedStates: Array<{ entryId: string; revision: number }>;
  plans: PlannedEntryState[];
  superseded: PullEntryStateManifestItem[];
  supersededPathsToRemove: string[];
  pathsToWrite: string[];
  pendingConflicts: PreparedPendingConflict[];
  batches: PreparedPathBatch[];
  deferred: PullEntryStateManifestItem[];
};

export type SnapshotEntryState = {
  remote: RemoteSyncEntryRow | null;
  local: LocalSyncEntryRow | null;
};

export function uniqueSyncPaths(
  paths: ReadonlyArray<string | null | undefined>,
): Array<string> {
  return [...new Set(paths.filter((path): path is string => !!path))];
}

export function isDeferredByCursorThreshold(
  item: PullEntryStateManifestItem,
  deferredCursorThreshold: number | null,
): boolean {
  return (
    deferredCursorThreshold !== null &&
    item.state.updatedSeq >= deferredCursorThreshold
  );
}

export async function mapWithConcurrency<TInput, TOutput>(
  items: ReadonlyArray<TInput>,
  concurrency: number,
  worker: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  if (items.length === 0) {
    return [];
  }

  const normalizedConcurrency = Number.isFinite(concurrency)
    ? Math.floor(concurrency)
    : 1;
  const workerCount = Math.max(1, Math.min(normalizedConcurrency, items.length));
  const results = new Array<TOutput>(items.length);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(items[index], index);
      }
    }),
  );

  return results;
}

export function createPathDependencyBatches(
  plans: ReadonlyArray<PlannedEntryState>,
): PlannedEntryState[][] {
  const pathToRoot = new Map<string, string>();
  const parent = new Map<string, string>();
  const planRootKeys = new Map<PlannedEntryState, string>();

  for (const [index, plan] of plans.entries()) {
    const paths = uniqueSyncPaths([
      ...pathsToRemoveForPlan(plan),
      ...pathsToWriteForPlan(plan),
    ]);
    const rootKey = paths[0] ?? `plan:${index}`;
    if (!parent.has(rootKey)) {
      parent.set(rootKey, rootKey);
    }
    planRootKeys.set(plan, rootKey);

    for (const path of paths) {
      const existingRoot = pathToRoot.get(path);
      if (existingRoot) {
        union(parent, rootKey, existingRoot);
      } else {
        pathToRoot.set(path, rootKey);
      }
    }
  }

  const batches = new Map<string, PlannedEntryState[]>();
  for (const plan of plans) {
    const rootKey = planRootKeys.get(plan);
    if (!rootKey) {
      continue;
    }
    const root = find(parent, rootKey);
    const batch = batches.get(root) ?? [];
    batch.push(plan);
    batches.set(root, batch);
  }

  return [...batches.values()];
}

export function packPathDependencyBatches(
  batches: PlannedEntryState[][],
  preferredBatchSize: number,
): PlannedEntryState[][] {
  const normalizedSize = Number.isFinite(preferredBatchSize)
    ? Math.max(1, Math.floor(preferredBatchSize))
    : 1;
  const packed: PlannedEntryState[][] = [];
  let current: PlannedEntryState[] = [];

  for (const batch of batches) {
    if (batch.length >= normalizedSize) {
      if (current.length > 0) {
        packed.push(current);
        current = [];
      }
      packed.push(batch);
      continue;
    }

    if (current.length + batch.length > normalizedSize) {
      packed.push(current);
      current = [];
    }
    current.push(...batch);
  }

  if (current.length > 0) {
    packed.push(current);
  }

  return packed;
}

export function groupPendingConflictsByPlan(
  pendingConflicts: ReadonlyArray<PreparedPendingConflict>,
): Map<PlannedEntryState, PreparedPendingConflict[]> {
  const grouped = new Map<PlannedEntryState, PreparedPendingConflict[]>();
  for (const pendingConflict of pendingConflicts) {
    const conflicts = grouped.get(pendingConflict.plan) ?? [];
    conflicts.push(pendingConflict);
    grouped.set(pendingConflict.plan, conflicts);
  }
  return grouped;
}

export function uniquePendingConflicts(
  pendingConflicts: ReadonlyArray<PreparedPendingConflict>,
): PreparedPendingConflict[] {
  const seen = new Set<string>();
  const unique: PreparedPendingConflict[] = [];
  for (const pendingConflict of pendingConflicts) {
    if (seen.has(pendingConflict.pending.mutationId)) {
      continue;
    }
    seen.add(pendingConflict.pending.mutationId);
    unique.push(pendingConflict);
  }
  return unique;
}

export function pathsToRemoveForPlan(
  plan: PlannedEntryState,
): Array<string | null | undefined> {
  if (plan.state.deleted) {
    // Metadata keeps the entry's historical path, which another entry may now
    // own. Only remove a path still associated with the deleted entry itself.
    return [plan.existing?.path];
  }

  if (plan.vaultMove) {
    return [];
  }

  return plan.existing?.path !== plan.finalPath ? [plan.existing?.path] : [];
}

export function pathsToWriteForPlan(
  plan: PlannedEntryState,
): Array<string | null | undefined> {
  return [plan.finalPath];
}

function find(parent: Map<string, string>, value: string): string {
  const next = parent.get(value);
  if (!next || next === value) {
    parent.set(value, value);
    return value;
  }

  const root = find(parent, next);
  parent.set(value, root);
  return root;
}

function union(parent: Map<string, string>, left: string, right: string): void {
  const leftRoot = find(parent, left);
  const rightRoot = find(parent, right);
  if (leftRoot !== rightRoot) {
    parent.set(rightRoot, leftRoot);
  }
}

export function metadataContextFromRemoteState(state: RemoteEntryState) {
  return {
    entryId: state.entryId,
    revision: state.revision,
    op: state.deleted ? ("delete" as const) : ("upsert" as const),
    blobId: state.blobId,
  };
}

export function metadataContextFromPendingMutation(mutation: PendingMutationRow) {
  return {
    entryId: mutation.entryId,
    revision: mutation.baseRevision + 1,
    op: mutation.op,
    blobId: mutation.blobId,
  };
}

export function requireBlobId(state: RemoteEntryState): string {
  if (!state.blobId) {
    throw new Error(`Entry state ${state.entryId}@${state.revision} is missing a blob.`);
  }
  return state.blobId;
}

export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
