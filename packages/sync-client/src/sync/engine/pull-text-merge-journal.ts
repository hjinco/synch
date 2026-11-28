import type { HashedBytes } from "../core/content";
import type { ContentReservation } from "../core/content-runtime";
import type { PullWriteIntent, TextMergeIntent } from "../store/store";
import { replaceVaultTextIfUnchanged } from "../vault/vault-writer";
import type { PullEntryStateApplierDeps, PullEntryStateStore } from "./pull-entry-state-applier";
import { isInterruptedWrite, PullJournalFiles } from "./pull-journal-files";
import { PullRemoteWriteRecovery } from "./pull-remote-write-journal";
import { PullLocalFilesChangedError } from "./pull-local-file-snapshots";
import { withSyncState } from "./sync-state-coordinator";

function mergeRemoteState({ entryId, path, mutation, remoteUpdatedAt }: TextMergeIntent) {
  return {
    entryId, path, revision: mutation.baseRevision, blobId: mutation.baseBlobId,
    hash: mutation.baseHash, updatedAt: remoteUpdatedAt, deleted: false,
  };
}

export async function commitTextMerge(store: PullEntryStateStore, intent: TextMergeIntent): Promise<void> {
  const { entryId, path, mutation } = intent;
  await store.applyRemoteState(mergeRemoteState(intent));
  await store.replaceDirtyEntry(mutation, { requireBaseBlob: true });
  await store.applyLocalState({
    entryId, path, blobId: mutation.blobId, hash: mutation.hash, deleted: false,
    updatedAt: mutation.createdAt, localMtime: null, localSize: null,
  });
}

function journalId(intent: PullWriteIntent): string {
  return intent.kind === "download" ? intent.journalId : intent.mutation.mutationId;
}

export class PullWriteRecovery {
  private readonly checked = new WeakMap<PullEntryStateStore, Promise<void>>();

  private readonly files: PullJournalFiles;
  readonly downloads: PullRemoteWriteRecovery;

  constructor(private readonly deps: PullEntryStateApplierDeps) {
    this.files = new PullJournalFiles(deps);
    this.downloads = new PullRemoteWriteRecovery(deps, this.files);
  }

  invalidate(store: PullEntryStateStore): void {
    this.checked.delete(store);
  }

  recover(store: PullEntryStateStore): Promise<void> {
    const checked = this.checked.get(store);
    if (checked) return checked;
    const recovery = this.recoverAll(store).catch((error: unknown) => {
      this.invalidate(store);
      throw error;
    });
    this.checked.set(store, recovery);
    return recovery;
  }

  private async recoverAll(store: PullEntryStateStore): Promise<void> {
    await this.deps.vaultAdapter.recoverInterruptedWrites?.();
    for (const entryId of await store.textMerges.listEntryIds()) {
      const initial = await store.textMerges.get(entryId);
      if (!initial) continue;
      const { path } = initial;
      if (await this.isExcluded(path)) {
        this.invalidate(store);
        continue;
      }

      const size = initial.kind === "download"
        ? (initial.source?.ciphertext?.length ?? 0) + (initial.target.ciphertext?.length ?? 0)
        : (initial.staged?.sourceCiphertext.length ?? 0) + (initial.staged?.mergedCiphertext.length ?? 0);
      const reservation = await this.deps.contentRuntime.reserve(size);
      try {
        const paths = initial.kind === "download" && initial.localPath ? [path, initial.localPath] : [path];
        await withSyncState(store, { entryIds: [entryId], paths }, async () => {
          const intent = await store.textMerges.get(entryId);
          if (!intent || journalId(intent) !== journalId(initial)) return;
          const finished = intent.kind === "download"
            ? await this.downloads.recover(store, intent, reservation)
            : await this.recoverEntry(store, intent, reservation);
          if (finished) {
            if (intent.kind === "download") {
              await this.deps.vaultAdapter.discardStagedWrite?.(intent.journalId);
            }
            await store.textMerges.remove(entryId);
          } else this.invalidate(store);
        });
      } finally {
        reservation.release();
      }
    }
  }

  private async isExcluded(path: string): Promise<boolean> {
    return !!(this.deps.isDeviceFileExcluded?.(path) ||
      this.deps.shouldApplyRemotePath?.(path, false) === false ||
      await this.deps.vaultAdapter.isExcludedPath?.(path));
  }

  /** False leaves the journal parked until the destination can be inspected. */
  private async recoverEntry(
    store: PullEntryStateStore, intent: TextMergeIntent, reservation: ContentReservation,
  ): Promise<boolean> {
    const { entryId, path, mutation } = intent;
    const state = await store.getEntryStateById(entryId);
    const pending = state?.dirty;
    if (!pending || pending.baseRevision > mutation.baseRevision ||
        (state.remote?.revision ?? 0) > mutation.baseRevision) return true;
    const installed = intent.installed ||
      (state.remote?.revision === mutation.baseRevision && state.remote.blobId === mutation.baseBlobId);
    // A watcher can replace the old mutation with an edit or rename. Keep its
    // current destination separate from the incoming revision's original path.
    const localPath = pending.op === "upsert" ? state.local?.path ?? path : path;
    if (localPath !== path && await this.isExcluded(localPath)) return false;
    const owner = await store.getLocalStateByPath(localPath);
    const disk = owner && owner.entryId !== entryId ? null : await this.files.readFile(localPath, reservation);
    const diskHash = disk?.hash ?? null;
    // If cleanup alone failed, keep the already queued follow-up's identity.
    if (installed && pending.baseRevision === mutation.baseRevision && pending.baseBlobId === mutation.baseBlobId &&
        pending.hash === diskHash && state.local?.hash === diskHash &&
        state.local.deleted === !disk && state.local.path === (disk ? localPath : null) &&
        state.remote?.revision === mutation.baseRevision) return true;
    if (intent.keepSource && intent.staged) {
      const bytes = await this.files.readStaged(intent.staged.mergedCiphertext, mutation.blobId, mutation.hash);
      await this.preserveMergeBesideSource(store, intent, { bytes, hash: mutation.hash }, reservation, localPath);
    } else if (localPath === path && disk?.hash === mutation.hash) {
      await commitTextMerge(store, intent);
    } else if (localPath === path && !installed && pending.mutationId === intent.sourceMutationId &&
        disk?.hash === intent.sourceHash) {
      // The original file and upload are intact. The incoming revision will replay.
      return true;
    } else {
      const possiblyPartial = localPath === path && diskHash !== intent.sourceHash ? disk : null;
      const repaired = !installed && intent.staged && diskHash !== mutation.hash &&
        await this.recoverInterruptedWrite(intent, intent.staged, possiblyPartial, reservation);
      if (repaired) {
        await store.textMerges.put({ ...intent, installed: true });
        await commitTextMerge(store, intent);
      } else {
        await this.files.rebaseDisk(store, mergeRemoteState(intent), localPath, diskHash);
      }
    }
    this.deps.onLocalMutationQueued?.();
    return true;
  }

  private async recoverInterruptedWrite(
    intent: TextMergeIntent, staged: NonNullable<TextMergeIntent["staged"]>,
    disk: HashedBytes | null, reservation: ContentReservation,
  ): Promise<boolean> {
    const { mutation, path } = intent;
    const { sourceBlobId, sourceCiphertext, mergedCiphertext } = staged;
    reservation.retain((sourceCiphertext.length + mergedCiphertext.length) * 4);
    const merged = await this.files.readStaged(mergedCiphertext, mutation.blobId, mutation.hash);
    if (disk && this.deps.vaultAdapter.canCompareTextForWrite?.(disk.bytes, path) !== false) {
      const source = await this.files.readStaged(sourceCiphertext, sourceBlobId, intent.sourceHash);
      if (isInterruptedWrite(disk.bytes, source, merged)) {
        // The prefix could itself be a user's edit. Preserve it before repairing.
        await this.files.saveRecoveryCopy(intent, intent.mutation.createdAt, disk, reservation);
        if (!await replaceVaultTextIfUnchanged(this.deps.vaultAdapter, path, disk.bytes, merged)) {
          throw new PullLocalFilesChangedError([path]);
        }
        return true;
      }
    }
    // The write outcome is ambiguous. Leave the current file (or deletion)
    // in place and preserve the complete merge, including the local input.
    await this.files.saveRecoveryCopy(intent, intent.mutation.createdAt, { bytes: merged, hash: mutation.hash }, reservation);
    return false;
  }

  async preserveMergeBesideSource(
    store: PullEntryStateStore, intent: TextMergeIntent,
    merged: HashedBytes, reservation: ContentReservation, localPath = intent.path,
  ): Promise<boolean> {
    // The host cannot compare the source without losing byte identity. Keep it
    // in place, including any newer save, and make the clean merge available separately.
    const base = mergeRemoteState(intent);
    const owner = await store.getLocalStateByPath(localPath);
    const readSource = async () => owner && owner.entryId !== intent.entryId ? null :
      await this.files.readFile(localPath, reservation);
    const disk = await readSource();
    const needsCopy = disk?.hash !== merged.hash;
    const copied = needsCopy && await this.files.saveRecoveryCopy(intent, intent.mutation.createdAt, merged, reservation);
    const latest = needsCopy ? await readSource() : disk;
    if (localPath === base.path && latest && latest.hash === base.hash) {
      await store.upsertEntry({ ...base, localMtime: null, localSize: null });
    } else {
      await this.files.rebaseDisk(store, base, localPath, latest?.hash ?? null);
    }
    return copied;
  }

}
