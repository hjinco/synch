import { TFile, TFolder, type Plugin, type WorkspaceLeaf } from "obsidian";
import { getConflictOriginalPath, isImagePath } from "@synch/sync-client/core";
import { toArrayBuffer } from "@synch/vault-crypto";

import {
  decodeConflictText,
  sameConflictBytes,
  type ConflictPreview,
  type ConflictFileSnapshot,
} from "./conflict-preview";

import type { SynchConflictFile } from "../contracts";
import {
  findConflictFiles,
  type ConflictAction,
  type ConflictVaultFile,
} from "./conflict-files";
import {
  SYNCH_CONFLICT_VIEW_TYPE,
  SynchConflictView,
  type ConflictViewController,
} from "./conflict-view";

/**
 * Automatic merge of a conflict copy into its original, or null when the two
 * cannot be merged.
 *
 * There is NO common ancestor available here. The sync store holds one (the
 * entry's base revision), but this UI deliberately does not read it: the copy is
 * just a vault file. Without an ancestor, a three-way merge cannot tell which
 * side made which change, and passing `original` as the base degenerates into
 * "take the copy" — `mergeText3(x, x, y)` is always clean and returns `y`.
 * Reporting that as a merge would silently replace the original with the copy
 * while telling the user their edits were combined.
 *
 * So this returns non-null only for the one case where combining is
 * unambiguous: the copy is the original plus appended lines, i.e. the original
 * is a clean prefix of the copy and every original line survives intact. That is
 * the common shape when a device adds to the end of a note, and it is safe
 * because nothing the original had is lost.
 */
function mergeSides(original: string, copy: string): string | null {
  if (original === copy) {
    return original;
  }

  return copy.startsWith(original) ? copy : null;
}

export interface SynchConflictControllerDeps {
  plugin: Plugin;
}

/**
 * Lists conflict copies and applies a resolution to the vault.
 *
 * There is deliberately no sync-engine involvement here. A conflict copy is an
 * ordinary vault file, and resolving one is an ordinary vault write: the plugin
 * already watches the vault, so the write is queued and synced like any other
 * edit. Deleting the copy is likewise a normal file deletion.
 */
export class SynchConflictController implements ConflictViewController {
  /** Copies the user has hidden for this session, keyed by path. */
  private readonly hidden = new Set<string>();

  constructor(private readonly deps: SynchConflictControllerDeps) {}

  /**
   * Opens the pane on user request, following Obsidian's documented
   * activate-view pattern: reuse a leaf of this type if the workspace already
   * has one, otherwise create one in the right sidebar, then reveal it.
   *
   * The pane is deliberately never created automatically at startup. Obsidian
   * saves open leaves with the workspace layout and restores them itself, so
   * the plugin only creates a leaf when the user asks for it; creating one on
   * every load would reopen a pane the user closed and, while restored leaves
   * are still being attached, can add a duplicate.
   */
  async openPane(): Promise<void> {
    const { workspace } = this.deps.plugin.app;
    let leaf: WorkspaceLeaf | null =
      workspace.getLeavesOfType(SYNCH_CONFLICT_VIEW_TYPE)[0] ?? null;

    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: SYNCH_CONFLICT_VIEW_TYPE, active: true });
    }

    // Awaiting reveal also loads the view if Obsidian deferred it.
    await workspace.revealLeaf(leaf);
  }

  /** Vault files that look like conflict copies, newest first. */
  async listConflicts(): Promise<SynchConflictFile[]> {
    const files: ConflictVaultFile[] = [];
    for (const file of this.deps.plugin.app.vault.getFiles()) {
      if (!(file instanceof TFile)) {
        continue;
      }

      // Deliberately NOT filtered with `shouldSyncPath`: that predicate excludes
      // `.sync-conflict-*` paths from syncing, which is precisely the set being
      // looked for here. Hidden folders are skipped by hand instead, so a copy
      // inside `.obsidian` is not presented as a user-facing conflict.
      if (file.path.split("/").some((segment) => segment.startsWith("."))) {
        continue;
      }

      files.push({
        path: file.path,
        stat: { size: file.stat.size, mtime: file.stat.mtime },
      });
    }

    return findConflictFiles(files).filter(
      (conflict) => !this.hidden.has(conflict.copyPath),
    );
  }

  /** Capture the exact bytes to compare and later validate, even for images. */
  async previewConflict(copyPath: string): Promise<ConflictPreview> {
    const originalPath = this.originalPathFor(copyPath);
    const { original, copy } = await this.readPair(originalPath, copyPath);
    const originalText = original ? decodeConflictText(original.bytes) : null;
    const copyText = decodeConflictText(copy.bytes);
    return {
      originalFile: original ? { path: original.path, bytes: original.bytes } : null,
      copyFile: { path: copy.path, bytes: copy.bytes },
      original: originalText,
      copy: copyText,
      merged: originalText !== null && copyText !== null && !isImagePath(originalPath)
        ? mergeSides(originalText, copyText)
        : null,
    };
  }

  async resolveConflict(
    copyPath: string,
    action: ConflictAction,
    displayedPreview: ConflictPreview,
  ): Promise<void> {
    if (!displayedPreview) {
      throw new Error("Open the conflict comparison before resolving.");
    }
    const originalPath = this.originalPathFor(copyPath);
    if (
      displayedPreview.copyFile.path !== copyPath ||
      (displayedPreview.originalFile && displayedPreview.originalFile.path !== originalPath)
    ) {
      throw filesChanged();
    }

    // All actions validate the pair the user reviewed. A missing original is
    // also part of the snapshot: a newly created file must never be overwritten.
    const current = await this.readPair(originalPath, copyPath);
    this.assertPairMatches(current, displayedPreview.originalFile, displayedPreview.copyFile);
    let expectedOriginal = current.original?.bytes ?? null;

    if (action === "keep-original") {
      if (!current.original) throw filesChanged();
    } else {
      const originalText = current.original ? decodeConflictText(current.original.bytes) : null;
      const copyText = decodeConflictText(current.copy.bytes);
      const merged = originalText !== null && copyText !== null && !isImagePath(originalPath)
        ? mergeSides(originalText, copyText)
        : null;
      if (action === "merge" && merged === null) {
        throw new Error("These versions cannot be merged automatically.");
      }
      const replacementText = action === "merge" ? merged : copyText;
      // An allowed merge is append-only, so its exact bytes are the copy's.
      expectedOriginal = current.copy.bytes;
      const { vault } = this.deps.plugin.app;

      if (!current.original) {
        await this.ensureParentFolders(originalPath);
        this.assertCurrent(current.copy);
        if (vault.getAbstractFileByPath(originalPath)) throw filesChanged();
        // createBinary fails if another writer creates the path during I/O.
        await vault.createBinary(originalPath, toArrayBuffer(expectedOriginal));
      } else if (originalText !== null && replacementText !== null) {
        // Check and write together, including edits arriving after the preflight.
        const original = current.original;
        await vault.process(original.file, (content) => {
          this.assertCurrent(original);
          this.assertCurrent(current.copy);
          if (content !== originalText) throw filesChanged();
          return replacementText;
        });
      } else {
        // Obsidian has no binary compare-and-swap API. Revalidate handles/stats
        // immediately before its write and retain the copy if post-write checks
        // detect an intervening edit. Edits inside modifyBinary cannot be made
        // conditional; replace this with binary CAS if Obsidian exposes one.
        this.assertCurrent(current.original);
        this.assertCurrent(current.copy);
        await vault.modifyBinary(current.original.file, toArrayBuffer(expectedOriginal));
      }
    }

    // A copy can be edited while the original's write is pending. Never trash
    // those newer bytes; likewise preserve it if the original changed/disappeared.
    const finalPair = action === "keep-original"
      ? current
      : await this.readPair(originalPath, copyPath);
    this.assertPairMatches(
      finalPair,
      expectedOriginal ? { path: originalPath, bytes: expectedOriginal } : null,
      displayedPreview.copyFile,
    );
    if (!finalPair.original) throw filesChanged();
    this.assertCurrent(finalPair.original);
    this.assertCurrent(finalPair.copy);
    // Respect the user's configured trash setting. The API has no conditional
    // trash operation, so keep the final checks adjacent to the call.
    await this.deps.plugin.app.fileManager.trashFile(finalPair.copy.file);
    this.hidden.delete(copyPath);
  }

  hideConflict(copyPath: string): void {
    this.hidden.add(copyPath);
  }

  refreshViews(paths?: readonly string[]): void {
    for (const leaf of this.deps.plugin.app.workspace.getLeavesOfType(
      SYNCH_CONFLICT_VIEW_TYPE,
    )) {
      const view = leaf.view;
      if (view instanceof SynchConflictView) {
        view.queueRefresh(paths);
      }
    }
  }

  private originalPathFor(copyPath: string): string {
    const originalPath = getConflictOriginalPath(copyPath);
    if (
      !originalPath || this.hidden.has(copyPath) ||
      copyPath.split("/").some((part) => part.startsWith(".")) ||
      !(this.deps.plugin.app.vault.getAbstractFileByPath(copyPath) instanceof TFile)
    ) {
      throw new Error("This file is not a conflict copy.");
    }
    return originalPath;
  }

  private async readPair(originalPath: string, copyPath: string): Promise<ConflictPair> {
    const original = await this.readSnapshot(originalPath);
    const copy = await this.readSnapshot(copyPath);
    if (!copy) throw filesChanged();
    if (original) this.assertCurrent(original);
    else if (this.deps.plugin.app.vault.getAbstractFileByPath(originalPath)) throw filesChanged();
    this.assertCurrent(copy);
    return { original, copy };
  }

  private async readSnapshot(path: string): Promise<CapturedFile | null> {
    const { vault } = this.deps.plugin.app;
    const file = vault.getAbstractFileByPath(path);
    if (!file) return null;
    if (!(file instanceof TFile)) throw filesChanged();
    const stat = { mtime: file.stat.mtime, size: file.stat.size };
    const bytes = new Uint8Array(await vault.readBinary(file));
    const snapshot = { path, file, stat, bytes };
    this.assertCurrent(snapshot);
    return snapshot;
  }

  private assertCurrent(snapshot: CapturedFile): void {
    const file = this.deps.plugin.app.vault.getAbstractFileByPath(snapshot.path);
    if (
      !(file instanceof TFile) || file !== snapshot.file || file.path !== snapshot.path ||
      file.stat.mtime !== snapshot.stat.mtime || file.stat.size !== snapshot.stat.size
    ) throw filesChanged();
  }

  private assertPairMatches(
    pair: ConflictPair,
    original: ConflictFileSnapshot | null,
    copy: ConflictFileSnapshot,
  ): void {
    if (
      Boolean(pair.original) !== Boolean(original) ||
      (pair.original && original && !sameConflictBytes(pair.original.bytes, original.bytes)) ||
      !sameConflictBytes(pair.copy.bytes, copy.bytes)
    ) throw filesChanged();
  }

  private async ensureParentFolders(path: string): Promise<void> {
    const parts = path.split("/").slice(0, -1);
    let current = "";
    for (const part of parts) {
      if (!part) continue;
      current = current ? `${current}/${part}` : part;
      if (!(this.deps.plugin.app.vault.getAbstractFileByPath(current) instanceof TFolder)) {
        await this.deps.plugin.app.vault.createFolder(current).catch(() => undefined);
      }
    }
  }
}

interface CapturedFile extends ConflictFileSnapshot {
  file: TFile;
  stat: { mtime: number; size: number };
}

interface ConflictPair {
  original: CapturedFile | null;
  copy: CapturedFile;
}

function filesChanged(): Error {
  return new Error("The files changed. Open the comparison and review them again.");
}
