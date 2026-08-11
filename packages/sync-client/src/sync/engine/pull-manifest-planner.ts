import type { SyncedEntryMetadata } from "../core/content";
import {
  type ConflictFileWriter,
  getAvailableConflictCopyPath,
} from "../core/conflict-file";
import { decryptSyncMetadata } from "../core/crypto";
import type { RemoteEntryState } from "../remote/changes";
import type {
  SyncEntryRow,
} from "../store/store";
import type {
  SyncEntryStore,
  SyncMutationStore,
} from "../store/ports";
import {
  type AdoptedLocalEntry,
  isDeferredByCursorThreshold,
  metadataContextFromPendingMutation,
  type PlannedEntryState,
  type PullConflictEvent,
  type PullEntryStateManifestItem,
  type PullRollbackEvent,
} from "./pull-entry-state-internal";

interface PullManifestPlannerDeps {
  getRemoteVaultKey: () => Uint8Array;
  vaultAdapter: ConflictFileWriter;
  onConflict?: (event: PullConflictEvent) => void;
  onRollbackDetected?: (event: PullRollbackEvent) => void;
  shouldUseLatestRemoteVersion?: (path: string) => boolean;
  now?: () => number;
}

export class PullManifestPlanner {
  constructor(private readonly deps: PullManifestPlannerDeps) {}

  async planManifest(
    store: PullManifestStore,
    manifest: PullEntryStateManifestItem[],
    options: { deferExternalPathOwners: boolean },
  ): Promise<{
    plans: PlannedEntryState[];
    deferred: PullEntryStateManifestItem[];
    superseded: PullEntryStateManifestItem[];
  }> {
    for (const item of manifest) {
      this.validateManifestItem(item);
    }

    const latestManagedEntryByPath = this.findLatestManagedEntryByPath(manifest);
    const activeManifest: PullEntryStateManifestItem[] = [];
    const superseded: PullEntryStateManifestItem[] = [];
    for (const item of manifest) {
      const winnerEntryId = latestManagedEntryByPath.get(item.metadata.path);
      if (winnerEntryId && winnerEntryId !== item.state.entryId) {
        const existing = await store.getEntryById(item.state.entryId);
        if (
          existing &&
          existing.revision > 0 &&
          item.state.revision < existing.revision
        ) {
          this.deps.onRollbackDetected?.({
            entryId: item.state.entryId,
            path: item.metadata.path,
            localRevision: existing.revision,
            remoteRevision: item.state.revision,
          });
          continue;
        }
        superseded.push(item);
        continue;
      }
      activeManifest.push(item);
    }

    const deferredEntryIds = new Set<string>();
    if (options.deferExternalPathOwners) {
      let changed = true;
      while (changed) {
        changed = false;
        const activeEntryIds = new Set(
          activeManifest
            .map((item) => item.state.entryId)
            .filter((entryId) => !deferredEntryIds.has(entryId)),
        );

        for (const { state, metadata } of activeManifest) {
          if (deferredEntryIds.has(state.entryId) || state.deleted) {
            continue;
          }
          if (!state.blobId) {
            throw new Error(`Entry state ${state.entryId}@${state.revision} is missing a blob.`);
          }
          if (!metadata.hash) {
            throw new Error(`Entry state ${state.entryId}@${state.revision} is missing a hash.`);
          }

          const pathOwner = await store.getEntryByPath(metadata.path);
          const adoptedLocalEntry = pathOwner
            ? await this.findAdoptableLocalPathOwner(store, state, metadata, pathOwner, metadata.hash)
            : null;
          const externalPathOwner =
            pathOwner &&
            pathOwner.entryId !== state.entryId &&
            !activeEntryIds.has(pathOwner.entryId) &&
            !adoptedLocalEntry;
          if (
            externalPathOwner &&
            !this.deps.shouldUseLatestRemoteVersion?.(metadata.path)
          ) {
            deferredEntryIds.add(state.entryId);
            changed = true;
          }
        }
      }
    }

    const deferredCursorThreshold =
      deferredEntryIds.size > 0
        ? Math.min(
            ...activeManifest
              .filter((item) => deferredEntryIds.has(item.state.entryId))
              .map((item) => item.state.updatedSeq),
          )
        : null;
    const deltaEntryIds = new Set(
      activeManifest
        .filter((item) => !isDeferredByCursorThreshold(item, deferredCursorThreshold))
        .map((item) => item.state.entryId),
    );
    const reservedPaths = new Map<string, string>();
    const plans: PlannedEntryState[] = [];
    const deferred: PullEntryStateManifestItem[] = [];

    for (const item of activeManifest) {
      const { state, metadata } = item;
      if (isDeferredByCursorThreshold(item, deferredCursorThreshold)) {
        deferred.push(item);
        continue;
      }

      const existing = await store.getEntryById(state.entryId);
      // A well-behaved server only ever hands out strictly increasing
      // revisions for a given entry - every legitimate mutation, delete, or
      // restore bumps it. The AEAD binds (entryId, revision, op, blobId), so
      // a stale-but-genuine ciphertext decrypts cleanly; nothing in the
      // crypto layer signals that it's *old*. A malicious or compromised
      // server can replay one verbatim and have it accepted as current
      // unless something checks recency here - so skip (not defer: this
      // isn't a legitimate item to retry later) rather than apply it.
      if (existing && existing.revision > 0 && state.revision < existing.revision) {
        this.deps.onRollbackDetected?.({
          entryId: state.entryId,
          path: metadata.path,
          localRevision: existing.revision,
          remoteRevision: state.revision,
        });
        continue;
      }

      let finalPath: string | null = null;
      let hash: string | null = null;
      let pathConflict: PullConflictEvent | null = null;
      let adoptedLocalEntry: AdoptedLocalEntry | null = null;
      let vaultMove: PlannedEntryState["vaultMove"] = null;
      let supersededPathOwner: SyncEntryRow | null = null;

      if (!state.deleted) {
        if (!state.blobId) {
          throw new Error(`Entry state ${state.entryId}@${state.revision} is missing a blob.`);
        }
        if (!metadata.hash) {
          throw new Error(`Entry state ${state.entryId}@${state.revision} is missing a hash.`);
        }
        hash = metadata.hash;

        const duplicateEntryId = reservedPaths.get(metadata.path);
        const pathOwner = await store.getEntryByPath(metadata.path);
        adoptedLocalEntry = pathOwner
          ? await this.findAdoptableLocalPathOwner(store, state, metadata, pathOwner, hash)
          : null;
        const externalPathOwner =
          pathOwner &&
          pathOwner.entryId !== state.entryId &&
          !deltaEntryIds.has(pathOwner.entryId) &&
          !adoptedLocalEntry;
        if (
          externalPathOwner &&
          options.deferExternalPathOwners &&
          !this.deps.shouldUseLatestRemoteVersion?.(metadata.path)
        ) {
          deferred.push(item);
          continue;
        }
        if (duplicateEntryId || externalPathOwner) {
          if (this.deps.shouldUseLatestRemoteVersion?.(metadata.path)) {
            supersededPathOwner =
              pathOwner && pathOwner.entryId !== state.entryId ? pathOwner : null;
            finalPath = metadata.path;
          } else {
            pathConflict = await this.createPathCollisionEvent(
              state.entryId,
              metadata.path,
              reservedPaths,
            );
            finalPath = pathConflict.conflictPath;
          }
        } else {
          finalPath = metadata.path;
        }

        if (!finalPath) {
          throw new Error(`Entry state ${state.entryId}@${state.revision} has no target path.`);
        }
        vaultMove = await this.planVaultMove(
          store,
          state.entryId,
          existing,
          finalPath,
          pathConflict,
          adoptedLocalEntry,
        );
        reservedPaths.set(finalPath, state.entryId);
      } else {
        if (metadata.hash !== null) {
          throw new Error(`Deleted entry state ${state.entryId}@${state.revision} has a hash.`);
        }
      }

      plans.push({
        state,
        existing,
        adoptedLocalEntry,
        vaultMove,
        skipVaultWrite: false,
        metadata,
        finalPath,
        hash,
        pathConflict,
        pendingConflict: null,
        supersededPathOwner,
      });
    }

    return { plans, deferred, superseded };
  }

  private validateManifestItem(item: PullEntryStateManifestItem): void {
    const { state, metadata } = item;
    if (!state.deleted) {
      if (!state.blobId) {
        throw new Error(`Entry state ${state.entryId}@${state.revision} is missing a blob.`);
      }
      if (!metadata.hash) {
        throw new Error(`Entry state ${state.entryId}@${state.revision} is missing a hash.`);
      }
      return;
    }

    if (metadata.hash !== null) {
      throw new Error(`Deleted entry state ${state.entryId}@${state.revision} has a hash.`);
    }
  }

  private findLatestManagedEntryByPath(
    manifest: PullEntryStateManifestItem[],
  ): Map<string, string> {
    const latest = new Map<string, PullEntryStateManifestItem>();
    for (const item of manifest) {
      const path = item.metadata.path;
      // Tombstones are scoped to their entry id. They must not defeat a live
      // state for another entry that now owns the same managed config path.
      if (item.state.deleted || !this.deps.shouldUseLatestRemoteVersion?.(path)) {
        continue;
      }

      const current = latest.get(path);
      if (
        !current ||
        item.state.updatedSeq > current.state.updatedSeq ||
        (item.state.updatedSeq === current.state.updatedSeq &&
          item.state.entryId > current.state.entryId)
      ) {
        latest.set(path, item);
      }
    }

    return new Map(
      [...latest].map(([path, item]) => [path, item.state.entryId]),
    );
  }

  private async planVaultMove(
    store: PullManifestStore,
    entryId: string,
    existing: SyncEntryRow | null,
    finalPath: string,
    pathConflict: PullConflictEvent | null,
    adoptedLocalEntry: AdoptedLocalEntry | null,
  ): Promise<PlannedEntryState["vaultMove"]> {
    if (
      !existing ||
      existing.entryId !== entryId ||
      existing.deleted ||
      !existing.path ||
      existing.path === finalPath ||
      pathConflict ||
      adoptedLocalEntry ||
      (await store.getDirtyEntryMutation(entryId))
    ) {
      return null;
    }

    if (
      !(await this.deps.vaultAdapter.exists(existing.path)) ||
      (await this.deps.vaultAdapter.exists(finalPath))
    ) {
      return null;
    }

    return {
      from: existing.path,
      to: finalPath,
    };
  }

  private async findAdoptableLocalPathOwner(
    store: PullManifestStore,
    state: RemoteEntryState,
    metadata: SyncedEntryMetadata,
    pathOwner: SyncEntryRow,
    remoteHash: string,
  ): Promise<AdoptedLocalEntry | null> {
    if (
      pathOwner.entryId === state.entryId ||
      pathOwner.revision !== 0 ||
      pathOwner.deleted ||
      pathOwner.path !== metadata.path
    ) {
      return null;
    }

    const pending = await store.getDirtyEntryMutation(pathOwner.entryId);
    if (!pending || pending.op !== "upsert") {
      return null;
    }

    const pendingMetadata = await decryptSyncMetadata(
      this.deps.getRemoteVaultKey(),
      pending.encryptedMetadata,
      metadataContextFromPendingMutation(pending),
    );
    if (pendingMetadata.path !== metadata.path || !pendingMetadata.hash) {
      return null;
    }

    return {
      entry: pathOwner,
      pending,
      hashMatches: pendingMetadata.hash === remoteHash && pathOwner.hash === remoteHash,
    };
  }

  private async createPathCollisionEvent(
    entryId: string,
    path: string,
    reservedPaths: ReadonlyMap<string, string>,
  ): Promise<PullConflictEvent> {
    let conflictPath = await getAvailableConflictCopyPath(
      this.deps.vaultAdapter,
      path,
      this.deps.now,
    );
    while (reservedPaths.has(conflictPath)) {
      conflictPath = await getAvailableConflictCopyPath(
        {
          exists: async (candidate) =>
            reservedPaths.has(candidate) || (await this.deps.vaultAdapter.exists(candidate)),
        },
        path,
        this.deps.now,
      );
    }

    const event = {
      entryId,
      op: "upsert" as const,
      reason: "remote_path_collision" as const,
      originalPath: path,
      conflictPath,
    };
    this.deps.onConflict?.(event);
    return event;
  }
}

export interface PullManifestStore
  extends Pick<SyncEntryStore, "getEntryById" | "getEntryByPath">,
    Pick<SyncMutationStore, "getDirtyEntryMutation"> {}
