import { ItemView, Notice, setIcon, setTooltip, TFile, type WorkspaceLeaf } from "obsidian";

import { t } from "../../i18n";
import { formatBytes } from "../settings/format";
import type { SynchConflictFile } from "../contracts";
import type { ConflictAction } from "./conflict-files";
import { openConfirmModal } from "../modals/confirm-modal";
import { ConflictPreviewModal, type ConflictPreviewModalOptions } from "./conflict-preview-modal";

export const SYNCH_CONFLICT_VIEW_TYPE = "synch-conflict-view";

export type ConflictPreview = NonNullable<ConflictPreviewModalOptions["preview"]>;

export interface ConflictViewController {
  listConflicts(): Promise<SynchConflictFile[]>;
  previewConflict(
    copyPath: string,
  ): Promise<ConflictPreview | null>;
  resolveConflict(
    copyPath: string,
    action: ConflictAction,
    preview?: ConflictPreview | null,
  ): Promise<void>;
  hideConflict(copyPath: string): void;
}

/**
 * Lists conflict copies left in the vault and lets the user settle each one.
 *
 * Every action ends in an ordinary vault write or delete, so the plugin's normal
 * file watching picks the change up and syncs it. Nothing here talks to the sync
 * engine directly.
 */
export class SynchConflictView extends ItemView {
  private requestId = 0;
  private loading = false;
  private conflicts: SynchConflictFile[] = [];
  private mergeablePaths = new Set<string>();
  private loadError: string | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly controller: ConflictViewController,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return SYNCH_CONFLICT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return t("conflict.viewName");
  }

  getIcon(): string {
    return "git-merge";
  }

  async onOpen(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const requestId = ++this.requestId;
    this.loading = true;
    this.render();

    try {
      const conflicts = await this.controller.listConflicts();
      if (requestId !== this.requestId) return;

      const mergeablePaths = new Set(
        (await Promise.all(
          conflicts.map(async (conflict) => {
            if (!conflict.originalExists) return null;
            try {
              const preview = await this.controller.previewConflict(conflict.copyPath);
              return preview !== null && preview.merged !== null
                ? conflict.copyPath
                : null;
            } catch {
              return null;
            }
          }),
        )).filter((path): path is string => path !== null),
      );
      if (requestId !== this.requestId) return;

      // Publish one refresh result atomically so a slower, stale refresh cannot
      // replace the current conflict list or merge-availability decisions.
      this.loadError = null;
      this.conflicts = conflicts;
      this.mergeablePaths = mergeablePaths;
    } catch (error) {
      if (requestId !== this.requestId) return;

      this.conflicts = [];
      this.loadError = error instanceof Error ? error.message : String(error);
    } finally {
      if (requestId === this.requestId) {
        this.loading = false;
        this.render();
      }
    }
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("synch-conflict-view");

    this.renderHeader(root);

    if (this.loadError) {
      root.createEl("p", { text: this.loadError, cls: "synch-conflict-error" });
      return;
    }

    if (this.loading && this.conflicts.length === 0) {
      root.createEl("p", { text: t("conflict.loading"), cls: "synch-conflict-muted" });
      return;
    }

    if (this.conflicts.length === 0) {
      root.createEl("p", { text: t("conflict.empty"), cls: "synch-conflict-muted" });
      return;
    }

    const list = root.createDiv({ cls: "synch-conflict-list" });
    for (const conflict of this.conflicts) {
      this.renderRow(list, conflict);
    }
  }

  /** Title, count, and refresh share one line so the list starts high in a narrow sidebar. */
  private renderHeader(root: HTMLElement): void {
    const header = root.createDiv({ cls: "synch-conflict-header" });
    const title = header.createDiv({ cls: "synch-conflict-title" });
    title.createSpan({ text: t("conflict.header") });
    if (!this.loadError && this.conflicts.length > 0) {
      title.createSpan({
        text: String(this.conflicts.length),
        cls: "synch-conflict-count",
        attr: { "aria-label": t("conflict.count", { count: this.conflicts.length }) },
      });
    }

    const refresh = header.createDiv({
      cls: "clickable-icon synch-conflict-refresh",
      attr: { role: "button", tabindex: "0" },
    });
    setIcon(refresh, "refresh-cw");
    setTooltip(refresh, t("refresh"));
    refresh.toggleClass("is-disabled", this.loading);
    refresh.addEventListener("click", () => {
      if (!this.loading) void this.refresh();
    });
  }

  /**
   * One copy per row, named by the file the user knows (the original) rather
   * than the long `.sync-conflict-*` name; the copy's own path stays available
   * in the tooltip. Only actions that cannot lose content are offered here.
   */
  private renderRow(container: HTMLElement, conflict: SynchConflictFile): void {
    const row = container.createDiv({ cls: "synch-conflict-row" });
    if (!conflict.originalExists) row.addClass("is-missing-original");

    const top = row.createDiv({ cls: "synch-conflict-row-top" });
    const name = top.createDiv({
      text: basename(conflict.originalPath),
      cls: "synch-conflict-row-name",
      attr: { role: "link", tabindex: "0" },
    });
    setTooltip(name, `${t("conflict.originalPath", { path: conflict.originalPath })}\n${t("conflict.copyPath", { path: conflict.copyPath })}`);
    name.addEventListener("click", () => {
      void this.openFile(conflict.originalExists ? conflict.originalPath : conflict.copyPath);
    });

    const dismiss = top.createDiv({
      cls: "clickable-icon synch-conflict-dismiss",
      attr: { role: "button", tabindex: "0", "aria-label": t("conflict.dismiss") },
    });
    setIcon(dismiss, "x");
    setTooltip(dismiss, t("conflict.dismissHint"));
    dismiss.addEventListener("click", () => {
      this.controller.hideConflict(conflict.copyPath);
      void this.refresh();
    });

    const location = [parentPath(conflict.originalPath), formatConflictTime(conflict.modifiedAt)]
      .filter((part): part is string => Boolean(part));
    row.createDiv({ text: location.join(" · "), cls: "synch-conflict-row-meta" });
    if (conflict.originalSize !== null) {
      row.createDiv({
        text: t("conflict.sizeDifference", {
          copySize: formatBytes(conflict.copySize),
          originalSize: formatBytes(conflict.originalSize),
        }),
        cls: "synch-conflict-row-meta",
      });
    }

    if (!conflict.originalExists) {
      row.createDiv({
        text: t("conflict.originalMissing"),
        cls: "synch-conflict-row-warning",
      });
    }

    const actions = row.createDiv({ cls: "synch-conflict-row-actions" });
    // Both entry points open the comparison so merging always uses a snapshot
    // the user has actually inspected, not the list's mergeability check.
    if (this.mergeablePaths.has(conflict.copyPath)) {
      const merge = this.addButton(actions, t("conflict.merge"), () => this.openPreview(conflict), true);
      setTooltip(merge, t("conflict.mergeAvailable"));
    }
    this.addButton(actions, `${t("conflict.resolve")}…`, () => this.openPreview(conflict));
  }

  private addButton(
    container: HTMLElement,
    label: string,
    onClick: () => void | Promise<void>,
    primary = false,
  ): HTMLButtonElement {
    const button = container.createEl("button", {
      text: label,
      cls: primary ? "synch-conflict-action mod-cta" : "synch-conflict-action",
    });
    button.disabled = this.loading;
    button.addEventListener("click", () => {
      void onClick();
    });
    return button;
  }

  private async openFile(path: string): Promise<void> {
    // Open by path, not link text: link resolution would treat an extensionless
    // name as a note and could create a new file instead of opening this one.
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file);
    }
  }

  /** Asks for confirmation, then applies one resolution to the vault. */
  private async applyAction(
    conflict: SynchConflictFile,
    action: ConflictAction,
    preview: ConflictPreview | null,
  ): Promise<void> {
    const path = conflict.originalPath;
    const [question, done] = action === "keep-original"
      ? [t("conflict.resolveKeepOriginal", { path }), t("conflict.resolvedKeepOriginal")]
      : action === "keep-copy"
        ? [t("conflict.resolveKeepCopy", { path }), t("conflict.resolvedKeepCopy")]
        : [t("conflict.resolveMerge", { path }), t("conflict.resolvedMerge")];
    if (!(await openConfirmModal(this.app, question, t("conflict.resolve")))) return;

    this.loading = true;
    this.render();
    try {
      await this.controller.resolveConflict(conflict.copyPath, action, preview);
      new Notice(done);
      await this.refresh();
    } catch (error) {
      new Notice(
        t("conflict.resolveFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      this.loading = false;
      this.render();
    }
  }

  private async openPreview(conflict: SynchConflictFile): Promise<void> {
    try {
      const preview = await this.controller.previewConflict(conflict.copyPath);
      new ConflictPreviewModal(this.app, {
        conflict,
        preview,
        onChoose: (action) => {
          void this.applyAction(conflict, action, preview);
        },
      }).open();
    } catch (error) {
      new Notice(
        t("conflict.resolveFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Folder of a vault path, or null for files at the vault root. */
function parentPath(path: string): string | null {
  const slashIndex = path.lastIndexOf("/");
  return slashIndex > 0 ? path.slice(0, slashIndex) : null;
}

function formatConflictTime(value: number): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
