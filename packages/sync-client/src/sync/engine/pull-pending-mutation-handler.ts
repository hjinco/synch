import { encodeBase64 } from "@synch/vault-crypto";
import { decodeUtf8 } from "../core/content";
import { metadataContextFromPendingMutation } from "../core/mutation-metadata";
import {
  type SyncContentRuntime,
  type ContentReservation,
} from "../core/content-runtime";
import { getAvailableConflictCopyPath } from "../core/conflict-file";
import {
  decryptSyncBlob,
  encryptSyncBlob,
  decryptSyncMetadata,
  encryptSyncMetadata,
} from "../core/crypto";
import type {
  PendingMutationRow,
  SyncEntryStateRow,
  TextMergeIntent,
} from "../store/store";
import {
  writeVaultBinary,
} from "../vault/vault-writer";
import {
  requireBlobId,
  type PlannedEntryState,
  type PreparedConflictCopy,
  type PreparedEntryBlob,
  type PreparedPendingConflict,
  type PreparedPendingMerge,
} from "./pull-entry-state-internal";
import type {
  PullEntryStateApplierDeps,
  PullEntryStateStore,
  PullEntryStateVaultAdapter,
} from "./pull-entry-state-applier";
import { mergeText3 } from "./text-merge";
import { isAutoMergeTextPath } from "./text-merge-policy";

export class PullPendingMutationHandler {
  private readonly contentRuntime: SyncContentRuntime;

  constructor(private readonly deps: PullEntryStateApplierDeps) {
    this.contentRuntime = deps.contentRuntime;
  }

  async prepareConflictingPendingMutations(
    store: PullEntryStateStore,
    plan: PlannedEntryState,
    remoteBlob: PreparedEntryBlob | null,
    reservation?: ContentReservation,
  ): Promise<PreparedPendingConflict[]> {
    const adoption = plan.adoptedLocalEntry;
    const primary = adoption
      ? await store.getDirtyEntryMutation(plan.state.entryId)
      : await this.findConflictingPendingMutation(store, plan);
    const owner = plan.supersededPathOwner;
    const displaced = owner && owner.entryId !== primary?.entryId
      ? await store.getDirtyEntryMutation(owner.entryId) : null;
    const conflicts: PreparedPendingConflict[] = [];
    for (const pending of [primary, displaced, adoption?.hashMatches ? null : adoption?.pending]) {
      if (pending) conflicts.push(await this.preparePendingConflict(store, plan, pending, remoteBlob, reservation));
    }
    return conflicts;
  }

  private async preparePendingConflict(
    store: PullEntryStateStore,
    plan: PlannedEntryState,
    pending: PendingMutationRow,
    remoteBlob: PreparedEntryBlob | null,
    reservation?: ContentReservation,
  ): Promise<PreparedPendingConflict> {
    const metadata = await decryptSyncMetadata(
      this.deps.getRemoteVaultKey(),
      pending.encryptedMetadata,
      metadataContextFromPendingMutation(pending),
    );
    const useRemote = await this.useRemoteVersionForPath(metadata.path);
    if (
      useRemote || await isSameEntryPendingMutationAlreadyRemote(
        pending,
        metadata,
        plan,
        this.deps.vaultAdapter,
        this.contentRuntime,
        reservation,
      )
    ) {
      return {
        plan,
        pending,
        event: null,
        conflictBytes: null,
        merge: { kind: !useRemote && pending.op === "upsert" ? "already-present" : "remote" },
      };
    }

    const entryState = await store.getEntryStateById(pending.entryId);
    const merge = await this.preparePendingTextMerge(
      store,
      plan,
      entryState,
      remoteBlob,
      reservation,
    );
    if (merge) {
      return {
        plan,
        pending,
        event: null,
        conflictBytes: null,
        merge,
      };
    }

    return { plan, merge: null, ...await this.prepareConflictCopy(pending, metadata.path, reservation) };
  }

  async prepareSupersededConflict(
    pending: PendingMutationRow,
    reservation: ContentReservation,
  ): Promise<PreparedConflictCopy | null> {
    const { path } = await decryptSyncMetadata(
      this.deps.getRemoteVaultKey(), pending.encryptedMetadata, metadataContextFromPendingMutation(pending),
    );
    if (await this.useRemoteVersionForPath(path)) return null;
    return await this.prepareConflictCopy(pending, path, reservation);
  }

  private async useRemoteVersionForPath(path: string): Promise<boolean> {
    return !!(this.deps.isDeviceFileExcluded?.(path) || this.deps.shouldUseLatestRemoteVersion?.(path) ||
      await this.deps.vaultAdapter.isExcludedPath?.(path));
  }

  private async prepareConflictCopy(
    pending: PendingMutationRow,
    path: string,
    reservation?: ContentReservation,
  ): Promise<PreparedConflictCopy> {
    let conflictPath: string | null = null;
    let conflictBytes: Uint8Array | null = null;
    // Only consult the fallback policy after attempting a clean text merge.
    // Path collisions and rollback protection are handled separately.
    if (
      this.deps.getConflictPolicy?.() !== "prefer-remote" &&
      pending.op === "upsert" &&
      (await this.deps.vaultAdapter.exists(path))
    ) {
      conflictBytes = await this.contentRuntime.withReadBytes(
        await this.deps.vaultAdapter.getFileSize(path),
        async () => await this.deps.vaultAdapter.readBytes(path),
        async (bytes) => bytes,
        reservation,
      );
      conflictPath = await getAvailableConflictCopyPath(
        this.deps.vaultAdapter,
        path,
        this.deps.now,
      );
    }

    const event = {
      entryId: pending.entryId,
      op: pending.op,
      reason: "local_pending_mutation" as const,
      originalPath: path,
      conflictPath,
    };
    return {
      pending,
      event,
      conflictBytes,
    };
  }

  async applyPreparedPendingConflict(
    store: PullEntryStateStore,
    prepared: PreparedConflictCopy,
  ): Promise<void> {
    if (!prepared.event) {
      return;
    }

    if (prepared.event.conflictPath && prepared.conflictBytes) {
      await writeVaultBinary(
        this.deps.vaultAdapter,
        prepared.event.conflictPath,
        prepared.conflictBytes,
      );
    }

    await store.clearDirtyEntryByMutationId(prepared.pending.mutationId);
    this.deps.onConflict?.(prepared.event);
  }

  private async preparePendingTextMerge(
    store: PullEntryStateStore,
    plan: PlannedEntryState,
    entryState: SyncEntryStateRow | null,
    remoteBlob: PreparedEntryBlob | null,
    reservation?: ContentReservation,
  ): Promise<PreparedPendingMerge | null> {
    const dirty = entryState?.dirty ?? null;
    const local = entryState?.local ?? null;
    const base = entryState?.base ?? null;
    if (
      dirty?.op !== "upsert" ||
      entryState?.entryId !== plan.state.entryId ||
      plan.state.deleted ||
      !plan.finalPath ||
      !local?.path ||
      local.path !== plan.finalPath ||
      !isAutoMergeTextPath(plan.finalPath) ||
      !base?.blobId ||
      !base.hash ||
      !remoteBlob ||
      !plan.hash
    ) {
      return null;
    }

    const finalPath = plan.finalPath;
    const baseHash = plan.hash;
    const localPath = local.path;

    const cachedBase = await store.getBlob(base.blobId);
    if (!cachedBase || cachedBase.hash !== base.hash) {
      return null;
    }
    if (!(await this.deps.vaultAdapter.exists(local.path))) {
      return null;
    }

    reservation?.retain(cachedBase.encryptedBytes.byteLength * 8);
    const baseBytes = await decryptSyncBlob(
      this.deps.getRemoteVaultKey(),
      cachedBase.encryptedBytes,
      { blobId: base.blobId },
    );

    return await this.contentRuntime.withReadBytes(
      await this.deps.vaultAdapter.getFileSize(localPath),
      async () => await this.deps.vaultAdapter.readBytes(localPath),
      async (localBytes) => {
        const baseText = decodeUtf8(baseBytes);
        const localText = decodeUtf8(localBytes);
        const remoteText = decodeUtf8(remoteBlob.bytes);
        if (baseText === null || localText === null || remoteText === null) {
          return null;
        }

        const merged = mergeText3(baseText, localText, remoteText);
        if (merged.status !== "clean") {
          return null;
        }

        let mergedBytes: Uint8Array = new TextEncoder().encode(merged.text);
        const hashed = await this.contentRuntime.hashAndReturnBytes(mergedBytes);
        mergedBytes = hashed.bytes;
        const mergedHash = hashed.hash;
        const keepSource = this.deps.vaultAdapter.canCompareTextForWrite?.(localText, finalPath) === false;
        if (mergedHash === plan.hash && !keepSource) {
          return { kind: "remote-text", sourceText: localText };
        }

        const blobId = crypto.randomUUID();
        const sourceBlobId = crypto.randomUUID();
        const key = this.deps.getRemoteVaultKey();
        reservation?.retain((localBytes.byteLength + mergedBytes.byteLength) * 4);
        const staged = {
          sourceBlobId,
          sourceCiphertext: encodeBase64(await encryptSyncBlob(key, localBytes, { blobId: sourceBlobId })),
          mergedCiphertext: encodeBase64(await encryptSyncBlob(key, mergedBytes, { blobId })),
        };
        const intent: TextMergeIntent = {
          entryId: dirty.entryId,
          path: finalPath,
          keepSource,
          sourceMutationId: dirty.mutationId,
          staged,
          sourceHash: await this.contentRuntime.hash(localBytes),
          remoteUpdatedAt: plan.state.updatedAt,
          mutation: {
            entryId: dirty.entryId,
            mutationId: crypto.randomUUID(),
            op: "upsert",
            baseRevision: plan.state.revision,
            baseBlobId: requireBlobId(plan.state),
            baseHash,
            blobId,
            hash: mergedHash,
            createdAt: Date.now(),
            encryptedMetadata: await encryptSyncMetadata(
              this.deps.getRemoteVaultKey(),
              { path: finalPath, hash: mergedHash },
              { entryId: dirty.entryId, revision: plan.state.revision + 1, op: "upsert", blobId },
            ),
          },
        };
        return keepSource ? { kind: "keep-source", merged: hashed, intent } :
          { kind: "local", sourceText: localText, bytes: mergedBytes, intent };
      },
      reservation,
    );
  }

  private async findConflictingPendingMutation(
    store: PullEntryStateStore,
    plan: PlannedEntryState,
  ): Promise<PendingMutationRow | null> {
    const entryMutation = await store.getDirtyEntryMutation(plan.state.entryId);
    if (entryMutation) {
      return entryMutation;
    }

    const candidatePaths = new Set(
      (plan.state.deleted
        // A tombstone must not consume another entry's pending mutation merely
        // because its historical metadata names the same path.
        ? [plan.existing?.path]
        : [plan.finalPath, plan.existing?.path]
      ).filter((path): path is string => !!path),
    );
    if (candidatePaths.size === 0) {
      return null;
    }

    const remoteVaultKey = this.deps.getRemoteVaultKey();
    for (const pending of await store.listDirtyEntries()) {
      const metadata = await decryptSyncMetadata(
        remoteVaultKey,
        pending.encryptedMetadata,
        metadataContextFromPendingMutation(pending),
      );
      if (candidatePaths.has(metadata.path)) {
        return pending;
      }
    }

    return null;
  }
}

async function isSameEntryPendingMutationAlreadyRemote(
  pending: PendingMutationRow,
  metadata: { path: string; hash: string | null },
  plan: PlannedEntryState,
  vaultAdapter: PullEntryStateVaultAdapter,
  contentRuntime: SyncContentRuntime,
  reservation?: ContentReservation,
): Promise<boolean> {
  if (pending.entryId !== plan.state.entryId) {
    return false;
  }

  if (pending.op === "delete") {
    return plan.state.deleted && metadata.path === plan.metadata.path;
  }

  if (
    plan.state.deleted ||
    metadata.path !== plan.finalPath ||
    metadata.hash === null ||
    metadata.hash !== plan.hash
  ) {
    return false;
  }

  if (!(await vaultAdapter.exists(metadata.path))) {
    return false;
  }

  return (
    await contentRuntime.readAndHash(
      await vaultAdapter.getFileSize(metadata.path),
      async () => await vaultAdapter.readBytes(metadata.path),
      reservation,
    )
  ).hash === metadata.hash;
}
