import { isImagePath } from "@synch/sync-client/core";
import { diffLines, type Change } from "diff";
import { Modal, Setting, TFile, type App } from "obsidian";

import { t } from "../../i18n";
import type { SynchConflictFile } from "../contracts";
import type { ConflictAction } from "./conflict-files";

export interface ConflictPreviewModalOptions {
  conflict: SynchConflictFile;
  /** Text of both sides, or null for a binary file or a missing original. */
  preview: { original: string; copy: string; merged: string | null } | null;
  /** Called after the modal closes with the side the user chose. */
  onChoose: (action: ConflictAction) => void;
}

/**
 * Comparison of a conflict copy against its original, and the only place the
 * whole-file choices are offered.
 *
 * "Keep original" and "Keep copy" each discard one side, so they are kept off
 * the list and placed under the comparison: the user picks a side while looking
 * at what that side contains, not from a file name alone.
 */
export class ConflictPreviewModal extends Modal {
  constructor(
    app: App,
    private readonly options: ConflictPreviewModalOptions,
  ) {
    super(app);
  }

  onOpen(): void {
    const { conflict, preview } = this.options;
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl).setName(t("conflict.previewHeader")).setHeading();
    contentEl.createDiv({
      cls: "synch-preview-path",
      text: t("conflict.originalPath", { path: conflict.originalPath }),
    });
    contentEl.createDiv({
      cls: "synch-preview-meta",
      text: t("conflict.copyPath", { path: conflict.copyPath }),
    });

    if (preview) {
      const hint = preview.merged === null
        ? t("conflict.mergeUnavailable")
        : t("conflict.mergeAvailable");
      contentEl.createDiv({ cls: "synch-conflict-modal-hint", text: hint });
      renderDiff(contentEl, preview.original, preview.copy);
    } else if (!conflict.originalExists) {
      contentEl.createDiv({
        cls: "synch-conflict-modal-hint synch-conflict-modal-warning",
        text: t("conflict.originalMissing"),
      });
      void this.renderCopyOnly(contentEl);
    } else if (isImagePath(conflict.originalPath) && isImagePath(conflict.copyPath)) {
      this.renderImages(contentEl);
    } else {
      contentEl.createDiv({ cls: "synch-conflict-modal-hint", text: t("conflict.binaryNotice") });
    }

    this.renderActions(contentEl);
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderActions(contentEl: HTMLElement): void {
    const { conflict, preview } = this.options;
    const buttons = contentEl.createDiv({ cls: "modal-button-container" });

    // "Keep original" is meaningless when there is no original to keep.
    if (conflict.originalExists) {
      this.addChoice(buttons, t("conflict.keepOriginal"), "keep-original");
    }
    this.addChoice(buttons, t("conflict.keepCopy"), "keep-copy");
    if (conflict.originalExists && preview !== null && preview.merged !== null) {
      this.addChoice(buttons, t("conflict.merge"), "merge", true);
    }
  }

  private addChoice(
    container: HTMLElement,
    label: string,
    action: ConflictAction,
    primary = false,
  ): void {
    const button = container.createEl("button", {
      text: label,
      cls: primary ? "mod-cta" : undefined,
    });
    button.addEventListener("click", () => {
      this.close();
      this.options.onChoose(action);
    });
  }

  /** Both images side by side, labelled like the text diff legend. */
  private renderImages(contentEl: HTMLElement): void {
    const { conflict } = this.options;
    const grid = contentEl.createDiv({ cls: "synch-conflict-image-compare" });
    this.renderImage(grid, conflict.originalPath, t("conflict.diffLegendOriginal"), "synch-preview-diff-legend-removed");
    this.renderImage(grid, conflict.copyPath, t("conflict.diffLegendCopy"), "synch-preview-diff-legend-added");
  }

  private renderImage(container: HTMLElement, path: string, label: string, legendClass: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    const figure = container.createDiv({ cls: "synch-conflict-image-side" });
    figure.createSpan({ cls: legendClass, text: label });
    const frame = figure.createDiv({ cls: "synch-preview-content synch-preview-image" });
    if (file instanceof TFile) {
      frame.createEl("img", { attr: { alt: path, src: this.app.vault.getResourcePath(file) } });
    }
  }

  /** With no original to compare against, show what keeping the copy restores. */
  private async renderCopyOnly(contentEl: HTMLElement): Promise<void> {
    const { conflict } = this.options;
    const file = this.app.vault.getAbstractFileByPath(conflict.copyPath);
    if (!(file instanceof TFile)) return;

    const slot = contentEl.createDiv();
    // Keep the body above the action buttons, which are rendered synchronously.
    contentEl.querySelector(".modal-button-container")?.before(slot);

    if (isImagePath(conflict.copyPath)) {
      slot.createDiv({ cls: "synch-preview-content synch-preview-image" })
        .createEl("img", { attr: { alt: conflict.copyPath, src: this.app.vault.getResourcePath(file) } });
      return;
    }

    try {
      const bytes = new Uint8Array(await this.app.vault.readBinary(file));
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      slot.createEl("pre", { cls: "synch-preview-content synch-preview-raw", text });
    } catch {
      slot.createDiv({ cls: "synch-conflict-modal-hint", text: t("conflict.binaryNotice") });
    }
  }
}

/**
 * Line diff between the original and the conflict copy.
 *
 * Reuses the `synch-preview-diff*` classes that the version preview already
 * styles, so the two views read the same.
 */
function renderDiff(contentEl: HTMLElement, original: string, copy: string): void {
  const diffEl = contentEl.createDiv({
    cls: "synch-preview-content synch-preview-diff",
  });
  const legend = diffEl.createDiv({ cls: "synch-preview-diff-legend" });
  legend.createSpan({
    cls: "synch-preview-diff-legend-removed",
    text: t("conflict.diffLegendOriginal"),
  });
  legend.createSpan({
    cls: "synch-preview-diff-legend-added",
    text: t("conflict.diffLegendCopy"),
  });

  const changes = diffLines(original, copy);
  if (changes.length === 1 && !changes[0]?.added && !changes[0]?.removed) {
    diffEl.createEl("p", {
      cls: "synch-preview-diff-empty",
      text: t("conflict.diffNoChanges"),
    });
    return;
  }

  const body = diffEl.createDiv({ cls: "synch-preview-diff-body" });
  for (const change of changes) {
    renderChange(body, change);
  }
}

function renderChange(container: HTMLElement, change: Change): void {
  const className = change.added
    ? "synch-preview-diff-added"
    : change.removed
      ? "synch-preview-diff-removed"
      : "synch-preview-diff-context";
  const marker = change.added ? "+" : change.removed ? "-" : " ";

  const lines = change.value.split("\n");
  const lineCount = change.value.endsWith("\n") ? lines.length - 1 : lines.length;
  for (let index = 0; index < lineCount; index += 1) {
    const row = container.createDiv({ cls: `synch-preview-diff-row ${className}` });
    row.createSpan({ cls: "synch-preview-diff-marker", text: marker });
    row.createEl("code", {
      cls: "synch-preview-diff-line",
      text: lines[index] === "" ? " " : lines[index],
    });
  }
}