import { decodeBase64, encodeBase64 } from "@synch/vault-crypto";
import { getAvailableConflictCopyPath } from "../core/conflict-file";
import { decodeUtf8 } from "../core/content";
import type { ContentReservation } from "../core/content-runtime";
import { decryptSyncBlob, encryptSyncBlob } from "../core/crypto";
import type { JournalBlob, RemoteWriteIntent } from "../store/store";
import { renameVaultPath, replaceVaultTextIfUnchanged, writeVaultBinaryIfAbsent, writeVaultBytes } from "../vault/vault-writer";
import type { PullEntryStateApplierDeps, PullEntryStateStore } from "./pull-entry-state-applier";
import type { PreparedEntryBlob } from "./pull-entry-state-internal";
import { isInterruptedWrite, PullJournalFiles } from "./pull-journal-files";
import { PullLocalFilesChangedError } from "./pull-local-file-snapshots";
import { isAutoMergeTextPath } from "./text-merge-policy";

export class PullRemoteWriteRecovery {
  constructor(private readonly deps: PullEntryStateApplierDeps, private readonly files: PullJournalFiles) {}

  async install(
    store: PullEntryStateStore, { plan, bytes, transfer, journalCiphertext }: PreparedEntryBlob,
    expectedHash: string | null, pendingMutationId: string | null, reservation: ContentReservation,
    mergeSource?: string, localPath?: string,
  ): Promise<void> {
    const path = plan.finalPath;
    const { entryId, revision, updatedAt, blobId } = plan.state;
    if (!path || !blobId || !plan.hash) throw new Error("Cannot stage a remote write without content.");
    const disk = expectedHash === null ? null : await this.files.readFile(path, reservation);
    if ((disk?.hash ?? null) !== expectedHash) throw new PullLocalFilesChangedError([path]);
    let source: JournalBlob | null = null;
    if (disk) {
      const oldBlobId = plan.existing?.blobId;
      const cached = oldBlobId && plan.existing?.hash === disk.hash ? await store.getBlob(oldBlobId) : null;
      source = cached?.hash === disk.hash ? { blobId: cached.blobId, hash: disk.hash }
        : await this.stageBytes(disk.bytes, disk.hash, crypto.randomUUID(), reservation);
    }
    // PullBlobPreparer caches the authenticated remote blob for every Markdown file.
    if (journalCiphertext) reservation.retain(journalCiphertext.byteLength * 2);
    const target: JournalBlob = { blobId, hash: plan.hash };
    if (journalCiphertext) target.ciphertext = encodeBase64(journalCiphertext);
    const journalId = crypto.randomUUID();
    await store.textMerges.put({
      kind: "download", entryId, path, revision, remoteUpdatedAt: updatedAt,
      ...(localPath && localPath !== path ? { localPath } : {}),
      journalId, createdAt: Date.now(), source, target, pendingMutationId,
    });
    const vault = this.deps.vaultAdapter;
    const installed = await transfer.run("write", async () => {
      if (mergeSource !== undefined) return await replaceVaultTextIfUnchanged(vault, path, mergeSource, bytes);
      if (!disk && vault.writeBytesIfAbsent) return await writeVaultBinaryIfAbsent(vault, path, bytes, journalId);
      if (disk && isAutoMergeTextPath(path) && decodeUtf8(bytes) !== null &&
          vault.canCompareTextForWrite?.(disk.bytes, path) !== false) {
        return await replaceVaultTextIfUnchanged(vault, path, disk.bytes, bytes);
      }
      // Check again after persisting the journal; editors do not hold sync's state lock.
      if ((await this.files.readFile(path, reservation))?.hash !== (expectedHash ?? undefined)) return false;
      await writeVaultBytes(vault, path, bytes);
      return true;
    }, (written) => written);
    if (!installed) {
      await store.textMerges.remove(entryId);
      throw new PullLocalFilesChangedError([path]);
    }
  }

  private async stageBytes(
    bytes: Uint8Array, hash: string, blobId: string, reservation: ContentReservation,
  ): Promise<JournalBlob> {
    reservation.retain(bytes.byteLength * 4);
    const encrypted = await encryptSyncBlob(this.deps.getRemoteVaultKey(), bytes, { blobId });
    return { hash, blobId, ciphertext: encodeBase64(encrypted) };
  }

  private async readJournalBlob(
    store: PullEntryStateStore, blob: JournalBlob, reservation: ContentReservation,
  ): Promise<Uint8Array> {
    if (blob.ciphertext !== undefined) {
      reservation.retain(blob.ciphertext.length * 4);
      return await this.files.readStaged(blob.ciphertext, blob.blobId, blob.hash);
    }
    const cached = await store.getBlob(blob.blobId);
    if (!cached) throw new Error("Cannot recover download: cached content is missing.");
    reservation.retain(cached.encryptedBytes.byteLength * 3);
    const bytes = await decryptSyncBlob(this.deps.getRemoteVaultKey(), cached.encryptedBytes, { blobId: blob.blobId });
    const checked = await this.deps.contentRuntime.hashAndReturnBytes(bytes);
    if (checked.hash !== blob.hash) throw new Error("Cannot recover download: content hash mismatch.");
    return checked.bytes;
  }

  async recover(
    store: PullEntryStateStore, intent: RemoteWriteIntent, reservation: ContentReservation,
  ): Promise<boolean> {
    const { entryId, target, source } = intent;
    const installedPath = intent.localPath ?? intent.path;
    const state = await store.getEntryStateById(entryId);
    if ((state?.remote?.revision ?? 0) > intent.revision) return true;
    if (state?.remote?.revision === intent.revision && state.local?.hash === target.hash &&
        state.local.path === installedPath && !state.dirty) return true;
    const renamedPath = state?.dirty?.op === "upsert" && state.dirty.mutationId !== intent.pendingMutationId
      ? state.local?.path : null;
    const path = renamedPath ?? installedPath;
    if (path !== intent.path && (this.deps.isDeviceFileExcluded?.(path) ||
        this.deps.shouldApplyRemotePath?.(path, false) === false || await this.deps.vaultAdapter.isExcludedPath?.(path))) {
      return false;
    }
    const disk = await this.files.readFile(path, reservation);
    // A process can stop after moving ambiguous bytes aside and before installing
    // the complete file. Only this recorded move authorizes filling an empty path.
    const moved = intent.displaced && await this.deps.vaultAdapter.exists(intent.displaced.path);
    if (!disk && !moved) return true;
    const renamedSource = path !== installedPath && !!disk && disk.hash === source?.hash;
    if (!renamedSource && disk && disk.hash === source?.hash && !moved) return true;

    const owner = await store.getLocalStateByPath(path);
    const restorePrevious = intent.displaced?.restorePrevious ?? (!!owner && owner.entryId !== entryId);
    const desired = restorePrevious ? source : target;
    if (disk?.hash !== desired?.hash) {
      const received = await this.readJournalBlob(store, target, reservation);
      const previous = source ? await this.readJournalBlob(store, source, reservation) : new Uint8Array();
      if (disk && !renamedSource && disk.hash !== target.hash && !isInterruptedWrite(disk.bytes, previous, received)) {
        // An independent save remains in place for normal reconciliation.
        return true;
      }
      const replacement = restorePrevious ? previous : received;
      const vault = this.deps.vaultAdapter;
      if (disk && desired && isAutoMergeTextPath(path) && decodeUtf8(replacement) !== null &&
          vault.canCompareTextForWrite?.(disk.bytes, path) !== false) {
        if (!renamedSource) await this.files.saveRecoveryCopy({ entryId, path }, intent.createdAt, disk, reservation);
        if (!await replaceVaultTextIfUnchanged(vault, path, disk.bytes, replacement)) {
          throw new PullLocalFilesChangedError([path]);
        }
      } else {
        if (disk) {
          const backup = await getAvailableConflictCopyPath(vault, path, () => intent.createdAt);
          await store.textMerges.put({ ...intent, displaced: { path: backup, restorePrevious } });
          // Rename preserves even a new save between inspecting the source and moving it.
          await renameVaultPath(vault, path, backup);
          this.deps.onConflict?.({
            entryId, op: "upsert", reason: "local_pending_mutation", originalPath: path, conflictPath: backup,
          });
        }
        if (desired && !await writeVaultBinaryIfAbsent(vault, path, replacement, intent.journalId)) {
          throw new PullLocalFilesChangedError([path]);
        }
        await vault.discardStagedWrite?.(intent.journalId);
      }
    }
    // A rename cycle can roll an earlier owner back into the store. The
    // group's replay, which releases all path claims, commits that case.
    if (restorePrevious) return true;
    const base = {
      entryId, path: intent.path, revision: intent.revision, blobId: target.blobId,
      hash: target.hash, deleted: false, updatedAt: intent.remoteUpdatedAt,
    };
    if (path !== installedPath) {
      // The rename watcher can run before recovery. Keep this entry's identity
      // but upload the repaired bytes at its new path, based on the incoming revision.
      if (isAutoMergeTextPath(path) && target.ciphertext !== undefined) {
        await store.putBlob({
          blobId: target.blobId, hash: target.hash, encryptedBytes: decodeBase64(target.ciphertext),
          role: "remote", refEntryId: entryId, cachedAt: Date.now(),
        });
      }
      await this.files.rebaseDisk(store, base, path, target.hash);
      this.deps.onLocalMutationQueued?.();
      return true;
    }
    if (state?.dirty && state.dirty.mutationId !== intent.pendingMutationId && state.dirty.hash !== disk?.hash) return true;
    await store.upsertEntry({ ...base, localMtime: null, localSize: null }, installedPath);
    if (state?.dirty) await store.clearDirtyEntryByMutationId(state.dirty.mutationId);
    return true;
  }
}
