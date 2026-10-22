import { TFile, TFolder, type Plugin, type WorkspaceLeaf } from "obsidian";

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

  /**
   * Reads both sides and reports whether they can be merged automatically.
   * Returns null for a non-text file, where only a whole-file choice applies.
   */
  async previewConflict(
    copyPath: string,
  ): Promise<{ original: string; copy: string; merged: string | null } | null> {
    const originalPath = await this.originalPathFor(copyPath);
    if (!originalPath) {
      return null;
    }

    const original = await this.readTextIfPresent(originalPath);
    const copy = await this.readTextIfPresent(copyPath);
    if (original === null || copy === null) {
      return null;
    }

    return { original, copy, merged: mergeSides(original, copy) };
  }

  /**
   * Applies a resolution.
   *
   * `merge` is rejected when the two sides overlap: the caller must fall back to
   * a whole-file choice rather than have something written that the user did not
   * pick.
   */
  async resolveConflict(copyPath: string, action: ConflictAction): Promise<void> {
    const originalPath = await this.originalPathFor(copyPath);
    if (!originalPath) {
      throw new Error("This file is not a conflict copy.");
    }

    if (action === "keep-original") {
      // The original already holds the version to keep; drop the copy.
      await this.deleteFile(copyPath);
      return;
    }

    if (action === "keep-copy") {
      // Conflict copies can be images, PDFs, or other binary assets. Preserve
      // their bytes exactly instead of decoding them through cachedRead().
      await this.writeBinary(originalPath, await this.readBinary(copyPath));
      await this.deleteFile(copyPath);
      return;
    }

    const merged = (await this.previewConflict(copyPath))?.merged ?? null;
    if (merged === null) {
      throw new Error("These versions overlap and cannot be merged automatically.");
    }

    await this.writeText(originalPath, merged);
    await this.deleteFile(copyPath);
  }

  hideConflict(copyPath: string): void {
    this.hidden.add(copyPath);
  }

  refreshViews(): void {
    for (const leaf of this.deps.plugin.app.workspace.getLeavesOfType(
      SYNCH_CONFLICT_VIEW_TYPE,
    )) {
      const view = leaf.view;
      if (view instanceof SynchConflictView) {
        void view.refresh();
      }
    }
  }

  private async originalPathFor(copyPath: string): Promise<string | null> {
    const conflicts = await this.listConflicts();
    return conflicts.find((conflict) => conflict.copyPath === copyPath)
      ?.originalPath ?? null;
  }

  private async readBinary(path: string): Promise<ArrayBuffer> {
    const file = this.deps.plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      throw new Error(`File not found: ${path}`);
    }

    return await this.deps.plugin.app.vault.readBinary(file);
  }

  /** Text content, or null when the file is missing or not valid UTF-8. */
  private async readTextIfPresent(path: string): Promise<string | null> {
    const file = this.deps.plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      return null;
    }

    const bytes = new Uint8Array(await this.deps.plugin.app.vault.readBinary(file));
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  }

  private async writeText(path: string, text: string): Promise<void> {
    const file = this.deps.plugin.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.deps.plugin.app.vault.modify(file, text);
      return;
    }

    // The original may have been deleted while the copy survived, in which case
    // resolving recreates it.
    await this.ensureParentFolders(path);
    await this.deps.plugin.app.vault.create(path, text);
  }

  private async writeBinary(path: string, content: ArrayBuffer): Promise<void> {
    const file = this.deps.plugin.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.deps.plugin.app.vault.modifyBinary(file, content);
      return;
    }

    await this.ensureParentFolders(path);
    await this.deps.plugin.app.vault.createBinary(path, content);
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

  /**
   * Removes a conflict copy after its content has been dealt with.
   *
   * Goes through `FileManager.trashFile` so the user's own deletion preference
   * (system trash, Obsidian trash, or permanent) is respected. A conflict copy
   * is the only record of content sync could not merge, so a plain `Vault.delete`
   * here could destroy the last copy of a user's edits against their wishes.
   */
  private async deleteFile(path: string): Promise<void> {
    const file = this.deps.plugin.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.deps.plugin.app.fileManager.trashFile(file);
    }
    this.hidden.delete(path);
  }
}