import { decodeBase64 } from "@synch/vault-crypto";
import { getAvailableConflictCopyPath } from "../core/conflict-file";
import { encodeUtf8, hashBytes, type HashedBytes } from "../core/content";
import type { ContentReservation } from "../core/content-runtime";
import { createSyncCryptoContext, decryptSyncBlob } from "../core/crypto";
import { writeVaultBinaryIfAbsent } from "../vault/vault-writer";
import { buildLocalDeleteMutation, buildLocalUpsertMutation } from "../core/mutation-queue";
import { isAutoMergeTextPath } from "./text-merge-policy";
import type { RemoteSyncEntryRow, TextMergeIntent } from "../store/store";
import type { PullEntryStateApplierDeps, PullEntryStateStore } from "./pull-entry-state-applier";

/** A write may truncate the destination first, or overwrite a prefix in-place. */
export function isInterruptedWrite(disk: Uint8Array, source: Uint8Array, merged: Uint8Array): boolean {
  let prefix = 0;
  while (prefix < disk.length && prefix < merged.length && disk[prefix] === merged[prefix]) prefix++;
  if (prefix === disk.length) return disk.length < merged.length;
  if (!prefix || disk.length !== source.length) return false;
  return disk.subarray(prefix).every((value, index) => value === source[prefix + index]);
}

export class PullJournalFiles {
  constructor(private readonly deps: PullEntryStateApplierDeps) {}

  private async fileKind(path: string): Promise<"file" | "folder" | null> {
    const vault = this.deps.vaultAdapter;
    if (vault.statKind) return await vault.statKind(path);
    return await vault.exists(path) ? "file" : null;
  }

  async readFile(path: string, reservation: ContentReservation): Promise<HashedBytes | null> {
    const vault = this.deps.vaultAdapter;
    if (await this.fileKind(path) !== "file") return null;
    try {
      return await this.deps.contentRuntime.readAndHash(
        await vault.getFileSize(path), () => vault.readBytes(path), reservation,
      );
    } catch (error) {
      if (await this.fileKind(path) !== "file") return null;
      throw error;
    }
  }

  async readStaged(ciphertext: string, blobId: string, hash: string): Promise<Uint8Array> {
    const bytes = await decryptSyncBlob(this.deps.getRemoteVaultKey(), decodeBase64(ciphertext), { blobId });
    const result = await this.deps.contentRuntime.hashAndReturnBytes(bytes);
    if (result.hash !== hash) throw new Error("Interrupted write has an invalid content hash.");
    return result.bytes;
  }

  async saveRecoveryCopy(
    intent: Pick<TextMergeIntent, "entryId" | "path">, timestamp: number,
    content: HashedBytes, reservation: ContentReservation,
  ): Promise<boolean> {
    const parts = intent.path.split("/");
    const name = parts.pop()!;
    // A parent folder may itself have been removed or replaced by a file.
    const vault = this.deps.vaultAdapter;
    while (parts.length && vault.statKind && await vault.statKind(parts.join("/")) !== "folder") parts.pop();
    const copyBeside = [...parts, name].join("/");
    const operationId = await hashBytes(encodeUtf8(JSON.stringify([intent.entryId, intent.path, timestamp, content.hash])));
    for (;;) {
      let alreadySaved = false;
      const conflictPath = await getAvailableConflictCopyPath({
        exists: async (candidate) => {
          const kind = await this.fileKind(candidate);
          if (kind !== "file") return kind !== null;
          alreadySaved = (await this.readFile(candidate, reservation))?.hash === content.hash;
          return !alreadySaved;
        },
      }, copyBeside, () => timestamp);
      if (alreadySaved) {
        await vault.discardStagedWrite?.(operationId);
        return false;
      }
      if (!await writeVaultBinaryIfAbsent(vault, conflictPath, content.bytes, operationId)) continue;
      this.deps.onConflict?.({
        entryId: intent.entryId, op: "upsert", reason: "local_pending_mutation",
        originalPath: intent.path, conflictPath,
      });
      return true;
    }
  }

  async rebaseDisk(
    store: PullEntryStateStore, base: RemoteSyncEntryRow, path: string, hash: string | null,
  ): Promise<void> {
    const { entryId } = base;
    // Preserve the incoming remote base even if the application stopped before
    // the DB commit. A later edit/delete must never conflict with this same base.
    await store.applyRemoteState(base);
    const metadataCrypto = createSyncCryptoContext(this.deps.getRemoteVaultKey());
    try {
      const input = { entryId, path, base, metadataCrypto };
      const dirty = hash === null
        ? await buildLocalDeleteMutation(input)
        : (await buildLocalUpsertMutation({ ...input, hash })).mutation;
      await store.applyReconcileEntryUpdates([{
        entryId, dirty, requireBaseBlob: hash !== null && isAutoMergeTextPath(path),
        local: {
          entryId, path: hash === null ? null : path, hash, blobId: dirty.blobId,
          deleted: hash === null, updatedAt: dirty.createdAt, localMtime: null, localSize: null,
        },
      }]);
    } finally {
      metadataCrypto.dispose();
    }
  }
}
