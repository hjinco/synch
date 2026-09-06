import {
  resolveSyncContentRuntime,
  type SyncContentRuntime,
} from "../core/content-runtime";
import { getAvailableConflictCopyPath } from "../core/conflict-file";
import {
  decryptSyncBlob,
  decryptSyncMetadata,
  encryptSyncMetadata,
} from "../core/crypto";
import type {
  PendingMutationRow,
  SyncEntryStateRow,
} from "../store/store";
import {
  writeVaultBinary,
  writeVaultBytes,
} from "../vault/vault-writer";
import {
  decodeUtf8,
  metadataContextFromPendingMutation,
  type PlannedEntryState,
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
    this.contentRuntime = resolveSyncContentRuntime(deps);
  }

  async prepareConflictingPendingMutation(
    store: PullEntryStateStore,
    plan: PlannedEntryState,
    remoteBlob: PreparedEntryBlob | null,
  ): Promise<PreparedPendingConflict | null> {
    const pending = await this.findConflictingPendingMutation(store, plan);
    if (!pending) {
      return null;
    }

    const metadata = await decryptSyncMetadata(
      this.deps.getRemoteVaultKey(),
      pending.encryptedMetadata,
      metadataContextFromPendingMutation(pending),
    );
    if (
      await isSameEntryPendingMutationAlreadyRemote(
        pending,
        metadata,
        plan,
        this.deps.vaultAdapter,
        this.contentRuntime,
      )
    ) {
      return {
        plan,
        pending,
        event: null,
        conflictBytes: null,
        merge: { kind: "remote" },
      };
    }

    if (this.deps.shouldUseLatestRemoteVersion?.(metadata.path)) {
      return {
        plan,
        pending,
        event: null,
        conflictBytes: null,
        merge: { kind: "remote" },
      };
    }

    const entryState = await store.getEntryStateById(pending.entryId);
    const merge = await this.preparePendingTextMerge(
      store,
      plan,
      entryState,
      remoteBlob,
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

    let conflictPath: string | null = null;
    let conflictBytes: Uint8Array | null = null;
    if (pending.op === "upsert" && (await this.deps.vaultAdapter.exists(metadata.path))) {
      conflictBytes = await this.contentRuntime.withReadBytes(
        await this.deps.vaultAdapter.getFileSize(metadata.path),
        async () => await this.deps.vaultAdapter.readBytes(metadata.path),
        async (bytes) => bytes,
      );
      conflictPath = await getAvailableConflictCopyPath(
        this.deps.vaultAdapter,
        metadata.path,
        this.deps.now,
      );
    }

    const event = {
      entryId: pending.entryId,
      op: pending.op,
      reason: "local_pending_mutation" as const,
      originalPath: metadata.path,
      conflictPath,
    };
    return {
      plan,
      pending,
      event,
      conflictBytes,
      merge: null,
    };
  }

  async applyPreparedPendingConflict(
    store: PullEntryStateStore,
    prepared: PreparedPendingConflict,
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

  async applyPreparedPendingMerge(
    store: PullEntryStateStore,
    prepared: PreparedPendingConflict,
  ): Promise<void> {
    if (!prepared.merge) {
      return;
    }

    if (prepared.merge.kind === "remote") {
      await store.clearDirtyEntryByMutationId(prepared.pending.mutationId);
      return;
    }

    const rebasedMutation = {
      mutationId: crypto.randomUUID(),
      entryId: prepared.pending.entryId,
      op: "upsert" as const,
      baseRevision: prepared.plan.state.revision,
      baseBlobId: prepared.plan.state.blobId,
      baseHash: prepared.plan.hash,
      blobId: prepared.merge.blobId,
      hash: prepared.merge.hash,
      encryptedMetadata: prepared.merge.encryptedMetadata,
      createdAt: Date.now(),
    };
    await writeVaultBytes(this.deps.vaultAdapter, prepared.merge.path, prepared.merge.bytes);
    await store.replaceDirtyEntry(rebasedMutation, { requireBaseBlob: true });
    await store.applyLocalState({
      entryId: prepared.pending.entryId,
      path: prepared.merge.path,
      blobId: prepared.merge.blobId,
      hash: prepared.merge.hash,
      deleted: false,
      updatedAt: Date.now(),
      localMtime: null,
      localSize: null,
    });
  }

  private async preparePendingTextMerge(
    store: PullEntryStateStore,
    plan: PlannedEntryState,
    entryState: SyncEntryStateRow | null,
    remoteBlob: PreparedEntryBlob | null,
  ): Promise<PreparedPendingMerge | null> {
    const dirty = entryState?.dirty ?? null;
    const local = entryState?.local ?? null;
    const base = entryState?.base ?? null;
    if (
      dirty?.op !== "upsert" ||
      !entryState ||
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
    const localPath = local.path;

    const cachedBase = await store.getBlob(base.blobId);
    if (!cachedBase || cachedBase.hash !== base.hash) {
      return null;
    }
    if (!(await this.deps.vaultAdapter.exists(local.path))) {
      return null;
    }

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
        if (mergedHash === plan.hash) {
          return { kind: "remote" };
        }

        const blobId = crypto.randomUUID();
        return {
          kind: "local",
          bytes: mergedBytes,
          blobId,
          hash: mergedHash,
          path: finalPath,
          encryptedMetadata: await encryptSyncMetadata(
            this.deps.getRemoteVaultKey(),
            {
              path: finalPath,
              hash: mergedHash,
            },
            {
              entryId: entryState.entryId,
              revision: plan.state.revision + 1,
              op: "upsert",
              blobId,
            },
          ),
        };
      },
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
    )
  ).hash === metadata.hash;
}
